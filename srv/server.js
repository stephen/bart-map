import Promise, { promisify } from 'bluebird';
import debugCreator from 'debug';

import { makeExecutableSchema } from 'graphql-tools';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { graphqlExpress } from 'graphql-server-express';
import { parse as parseCsv } from 'csv';
import { readFile } from 'fs';
import path from 'path';

import {
  fetchStations,
  fetchRoutesWithSchedules,
} from './bart-api';

import TrainWatcher from './train-watcher';

const debug = debugCreator('bart');

const pReadFile = promisify(readFile);
const pParseCsv = promisify(parseCsv);

async function readAndParseShapes() {
  const fileContent = await pReadFile(path.join(__dirname, '../data/bart/shapes.txt'));
  const csvContent = await pParseCsv(fileContent, { columns: true });

  const mapping = csvContent.reduce((map, {
    shape_id: key,
    shape_pt_lat: lat,
    shape_pt_lon: lng,
    shape_pt_sequence: seq,
  }) => {
    if (!map[key]) {
      map[key] = [];
    }

    map[key].push({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      seq: parseInt(seq, 10),
    });

    return map;
  }, {});

  return Object.entries(mapping)
    .reduce((shapes, [key, points]) => {
      shapes.push({ key, points });
      return shapes;
    }, []);
}

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

schema {
  query: Query
}

type Route {
  number: Int!
  name: String!
  abbr: String!
  color: String!
  points: [Point]!
}

type Point {
  lat: Float!
  lng: Float!
}

type Query {
  trains: [Train]!
  stations: [Station]!
  routes: [Route]!
}
`;

async function main() {
  debug('fetching station + routes...');
  const [stations, routes] = await Promise.all([
    fetchStations(),
    fetchRoutesWithSchedules(),
  ]);
  debug('done');

  debug('reading route shapes...');
  const routeShapes = await readAndParseShapes();
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
      routes() {
        return routes;
      }
    },
    Station: {
      id(station) {
        return station.abbr;
      }
    },
    Route: {
      points(route) {
        return routeShapes
          .find(routeShape => routeShape.key.includes(route.number))
          .points;
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
