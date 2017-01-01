import Promise from 'bluebird';
import debugCreator from 'debug';

import {
  fetchStations,
  fetchRoutesWithSchedules,
} from './bart-api';

import TrainWatcher from './train-watcher';

const debug = debugCreator('bart');

async function main() {
  debug('fetching station + routes...');
  const [stations, routes] = await Promise.all([
    fetchStations(),
    fetchRoutesWithSchedules(),
  ]);
  debug('done');

  const watcher = new TrainWatcher(stations, routes);
  watcher.start();
}

main();
