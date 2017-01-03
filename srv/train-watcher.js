import { isEqual } from 'lodash';
import debugCreator from 'debug';
import moment from 'moment';
import assert from 'assert';

import { fetchRouteEtds } from './bart-api';

const debug = debugCreator('bart:watcher');

export function computeAverageTimeBetweenStations(routes, schedules = null) {
  return routes.reduce((routeMap, route) => {
    const schedule = schedules ? schedules[route.number] : route.schedule;
    const tripLengths = schedule.trains.reduce((map, train) => {
      train.stops.reduce((previous, stop) => {
        if (!previous) {
          return stop;
        }

        const key = `${ previous.station }-${ stop.station }`;
        if (!map[key]) {
          map[key] = [];
        }
        map[key].push(stop.time.diff(previous.time, 'minutes'));

        return stop;
      }, null);

      return map;
    }, {});

    routeMap[route.number] = Object.entries(tripLengths).reduce((map, [key, values]) => {
      map[key] = values.reduce((sum, time) => sum + time, 0) / values.length;
      return map;
    }, {});

    return routeMap;
  }, {});
}

class Train {
  constructor(id, segment, initialEtd) {
    assert(initialEtd, 'Train must be initialized with an estimate');
    this.id = id;
    this.cars = initialEtd.cars;
    this.segment = segment;
    this.updates = [];
    this.averageMinutes = initialEtd.expected;

    this.update(initialEtd);
  }

  get originAbbr() {
    return this.segment.split('-')[0];
  }

  get destinationAbbr() {
    return this.segment.split('-')[1];
  }

  update(etd) {
    const mostRecentUpdate = this.updates[this.updates.length - 1];
    const hasChange = !mostRecentUpdate || mostRecentUpdate.minutes !== etd.minutes;

    if (!hasChange) {
      return;
    }

    const update = {
      timestamp: moment(),
      minutes: etd.minutes,
    };

    this.updates.push(update);

    // debug(`updated train ${ this.id }:`, this.updates.map(update => `[${ update.timestamp.format('MM/DD@HH:mm:ss') }] ${ update.minutes }m`).join(', '));
  }

  printStats() {
    debug(`stats for train ${ this.id }:`);
    for (let i = 0; i < this.updates.length; i++) {
      const update = this.updates[i];
      const prev = this.updates[i - 1];

      const diff = prev ? ` (diff: ${ update.timestamp.diff(prev.timestamp, 'seconds') }s)` : '';
      debug(`[${ update.timestamp.format('MM/DD@HH:mm:ss') }] ${ update.minutes }m${ diff }`);
      if (prev && update.minutes > prev.minutes) {
        debug('!!! train time increased ^^^')
      }
    }
  }
}

class TrainWatcher {
  constructor(stations, routes) {
    this.stations = stations;
    this.routes = routes;

    this.trainCounter = 0;

    // train id -> train instance
    this.trains = new Map();

    // station abbr -> array,
    // where index is synced to lastEtdMap
    // indexes, and value is the train id
    this.stationToTrainIndex = new Map();

    // segments -> etds[]
    this.lastEtdMap = null;

    this.UPDATE_INTERVAL = 1000 * 10; // 10 seconds
  }

  async start() {
    const initialEtdMap = await this.fetchStationEtds();

    Object.entries(initialEtdMap).forEach(([segmentAbbr, etds]) => {
      const indexMapping = [];
      etds.forEach(etd => {
        const id = this.addTrain(segmentAbbr, etd);
        indexMapping.push(id);
      });
      this.stationToTrainIndex.set(segmentAbbr, indexMapping);
    });

    this.lastEtdMap = initialEtdMap;

    setInterval(this.update.bind(this), this.UPDATE_INTERVAL);
  }

  async update() {
    const fetchedEtdMap = await this.fetchStationEtds();

    new Set([
      ...Object.keys(fetchedEtdMap),
      ...Object.keys(this.lastEtdMap),
    ]).forEach((segmentAbbr) => {
      const currentEtds = fetchedEtdMap[segmentAbbr] || [];
      const previousEtds = this.lastEtdMap[segmentAbbr] || [];

      if (isEqual(currentEtds, previousEtds)) {
        return;
      }

      // Assumes that leaving trains are at the beginning, since
      // estimates are sorted - count the number of leaving trains
      // before / after
      const currentLeaving = currentEtds.filter(etd => etd.minutes === -1).length;
      const previousLeaving = previousEtds.filter(etd => etd.minutes === -1).length;

      const newlyUntrackedTrainCount = Math.max(previousLeaving - currentLeaving, 0);
      const remappedPrevious = Array.from(previousEtds);

      const indexMapping = this.stationToTrainIndex.get(segmentAbbr) || [];

      debug(segmentAbbr, previousEtds, currentEtds);

      // Remove stale trains.
      remappedPrevious.splice(0, newlyUntrackedTrainCount);
      const removedTrainIds = indexMapping.splice(0, newlyUntrackedTrainCount);
      removedTrainIds.forEach(trainId => {
        debug('invalidating train:', trainId, `(${ segmentAbbr })`);
        this.trains.get(trainId).printStats();
        this.trains.delete(trainId);
      });

      // Add new trains.
      if (currentEtds.length > remappedPrevious.length) {
        currentEtds.slice(remappedPrevious.length).forEach(etd => {
          const id = this.addTrain(segmentAbbr, etd);
          indexMapping.push(id);
        });
      }

      // Update existing trains.
      currentEtds.slice(0, remappedPrevious.length).forEach((etd, index) => {
        const trainId = indexMapping[index];
        this.trains.get(trainId).update(etd);
      });

      this.stationToTrainIndex.set(segmentAbbr, indexMapping);
    });

    this.lastEtdMap = fetchedEtdMap;
  }

  async fetchStationEtds() {
    debug(`[${ moment().format() }] fetching...`);
    const stationEtds = await fetchRouteEtds();

    const stationTimes = computeAverageTimeBetweenStations(this.routes);

    const segmentsToTrains = {};
    this.stations.forEach(station => {
      // ignore stations without etds, e.g. oakland airport ext.
      if (!stationEtds[station.abbr]) {
        return;
      }

      stationEtds[station.abbr].forEach(line => {
        const dest = line.destinationAbbr;

        const candidateRoutes = this.routes.filter(route =>
          route.schedule.trains.find(train =>
            train.stops.some(stop => stop.station === station.abbr) &&
            train.stops.some(stop => stop.station === dest) &&
            train.stops.findIndex(stop => stop.station === station.abbr) < train.stops.findIndex(stop => stop.station === dest)
          )
        );

        assert(
          candidateRoutes.length > 0,
          `Could not find candidate route for train from ${ station.abbr } to ${ dest }`,
        );

        // for now, pick an arbitrary route train
        // that contain the station and the correct destination
        const route = candidateRoutes[0];
        const train = route.schedule.trains.find(train =>
          train.stops.some(stop => stop.station === station.abbr) &&
          train.stops.some(stop => stop.station === dest) &&
          train.stops.findIndex(stop => stop.station === station.abbr) < train.stops.findIndex(stop => stop.station === dest)
        );

        const nextStop = train.stops[train.stops.findIndex(stop => stop.station === station.abbr) + 1];

        assert(nextStop, `Could not find next stop from ${ station.abbr } on ${ route.abbr }`)
        const nextStation = this.stations.find(station => station.abbr === nextStop.station);
        const stationsKey = `${ station.abbr }-${ nextStop.station }`;
        const avgTravelTime = stationTimes[route.number][stationsKey];

        // ignore estimates that are probably past this station.
        const nearbyEstimates = line.estimates.filter(estimate => estimate.minutes < avgTravelTime);
        nearbyEstimates.forEach(estimate => {

          if (!segmentsToTrains[stationsKey]) {
            segmentsToTrains[stationsKey] = [];
          }
          segmentsToTrains[stationsKey].push({ ...estimate, expected: avgTravelTime });
        });
      });
    });
    debug(`[${ moment().format() }] done`);

    Object.keys(segmentsToTrains).forEach(key => segmentsToTrains[key].sort((a, b) => a.minutes - b.minutes));
    return segmentsToTrains;
  }

  addTrain(segment, etd) {
    const id = this.trainCounter++;
    this.trains.set(id, new Train(id, segment, etd));
    return id;
  }
}

export default TrainWatcher;
