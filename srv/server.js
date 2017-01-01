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
}

type TrainUpdate {
  timestamp: Int! # Date?
  minutes: Int!
}

type Query {
  trains: [Train]
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
    },
    Train: {
      updates(train) {
        return train.updates.map(update => ({
          ...update,
          timestamp: update.timestamp.unix(),
        }));
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
