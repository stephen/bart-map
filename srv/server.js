import Promise from 'bluebird';
import debugCreator from 'debug';

import { makeExecutableSchema } from 'graphql-tools';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { graphqlExpress } from 'graphql-server-express';

import {
  fetchStations,
  fetchRoutesWithSchedules,
} from './bart-api';

import TrainWatcher from './train-watcher';

const debug = debugCreator('bart');

const graphqlSchema = `
type Train {
  id: Int!
  updates: [TrainUpdate]!
  cars: Int!
  origin: Station!
  destination: Station!
  averageMinutes: Float!
}

type Station {
  id: String!
  name: String!
  address: String!
  city: String!
  zipcode: String!
  county: String!
  lat: Float!
  lng: Float!
}

type TrainUpdate {
  timestamp: Int! # Date?
  minutes: Int!
}

type Query {
  trains: [Train]
  stations: [Station]
}

schema {
  query: Query
}
`;

async function main() {
  debug('fetching station + routes...');
  const [stations, routes] = await Promise.all([
    fetchStations(),
    fetchRoutesWithSchedules(),
  ]);
  debug('done');

  const watcher = new TrainWatcher(stations, routes);
  watcher.start();

  const resolvers = {
    Query: {
      trains() {
        return Array.from(watcher.trains.values());
      },
      stations() {
        return stations;
      },
    },
    Station: {
      id(station) {
        return station.abbr;
      }
    },
    Train: {
      updates(train) {
        return train.updates.map(update => ({
          ...update,
          timestamp: update.timestamp.unix(),
        }));
      },
      origin(train) {
        return stations.find(station => station.abbr === train.originAbbr);
      },
      destination(train) {
        return stations.find(station => station.abbr === train.destinationAbbr);
      },
    },
  };

  const executableSchema = makeExecutableSchema({
    typeDefs: graphqlSchema,
    resolvers: resolvers,
  });

  const PORT = 3001;
  const app = express();

  app.use('/graphql', cors(), bodyParser.json(), graphqlExpress({ schema: executableSchema }));

  app.listen(PORT);
}

main();
