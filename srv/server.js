import Promise, { promisify } from 'bluebird';
import debugCreator from 'debug';
import fetch from "isomorphic-fetch";
import { Parser as XmlParser } from 'xml2js';
import moment from 'moment';
import assert from 'assert';
import { isEqual } from 'lodash';

const debug = debugCreator('bart');
const verbose = debugCreator('bart:verbose');

const parser = new XmlParser();
const parseXmlString = promisify(parser.parseString);
const responseToJson = resp => resp.text().then(resp => parseXmlString(resp));

const BART_BASE_URL = 'https://api.bart.gov/api';
const BART_API_KEY = 'MW9S-E7SL-26DU-VV8V';
const BART_SERVICE_END = moment('2:27 AM', 'hh:mm A');

function fetchRoutes() {
  return fetch(`https://api.bart.gov/api/route.aspx?cmd=routes&key=${ BART_API_KEY }`)
    .then(responseToJson)
    .then(resp => resp.root.routes[0].route.map(
      route => ({
        name: route.name[0],
        abbr: route.abbr[0],
        color: route.color[0],
        number: parseInt(route.number[0], 10),
      })
    ));
}

async function fetchRoutesWithSchedules() {
  const routes = await fetchRoutes();
  return await Promise.all(routes.map(route =>
    fetchRouteSchedule(route.number).then(schedule => ({ ...route, schedule }))
  ));
}

function fetchRouteSchedule(routeNumber) {
  return fetch(`https://api.bart.gov/api/sched.aspx?cmd=routesched&route=${ routeNumber }&key=MW9S-E7SL-26DU-VV8V`)
    .then(responseToJson)
    .then(resp => resp.root)
    .then(resp => ({
      // if the route does not run on this day, this is empty
      // TODO: refetch this per day, or always check a weekday?
      trains: (resp.route[0].train || []).map(train => ({
        // some stops have no `origTime` - assume this means
        // that the train does not stop at the station?
        stops: train.stop.filter(({ $: stop }) => stop.origTime).map(({ $: stop }) => ({
          station: stop.station,
          load: parseInt(stop.load, 10),
          bike: stop.bikeflag === '1',
          level: stop.level,
          time: ((timeString) => {
            const m = moment(timeString, 'hh:mm A');

            // account for barttime(tm)
            // https://api.bart.gov/docs/overview/barttime.aspx
            if (m.isBefore(BART_SERVICE_END)) {
              m.add(1, 'day');
            }

            return m;
          })(stop.origTime),
        })),
        id: train['$'].trainId[0],
        trainIndex: parseInt(train['$'].trainIdx[0], 10),
      })),
      date: moment(resp.date[0], 'MM/DD/YYYY'),
      scheduleNumber: parseInt(resp.sched_num[0], 10),
    }));
}

function fetchStations() {
  return fetch(`${ BART_BASE_URL }/stn.aspx?cmd=stns&key=${ BART_API_KEY }`)
    .then(responseToJson)
    .then(resp => resp.root.stations[0].station)
    .then(stations =>
      stations.map((station, i) => ({
        name: station.name[0],
        abbr: station.abbr[0],
        address: station.address[0],
        city: station.city[0],
        zipcode: station.zipcode[0],
        county: station.county[0],
        lng: parseFloat(station.gtfs_longitude[0]),
        lat: parseFloat(station.gtfs_latitude[0]),
      }))
    );
}

function fetchRouteEtds() {
  return fetch(`https://api.bart.gov/api/etd.aspx?cmd=etd&orig=all&key=MW9S-E7SL-26DU-VV8V`)
    .then(responseToJson)
    .then(resp =>
      resp.root.station.reduce((map, station) => {
        map[station.abbr[0]] = station.etd.map(etd => ({
          destinationAbbr: etd.abbreviation[0],
          destination: etd.destination[0],
          // The `.sort()` assumes that trains headed to the same
          // station cannot pass each other. This is probably not
          // true as plenty of bart has > 2 tracks.
          // see: https://transbay.files.wordpress.com/2008/07/bart-track-map_2500x2747.parseString
          estimates: etd.estimate.map(estimate => ({
            bike: estimate.bikeflag[0] === '1',
            cars: parseInt(estimate.length[0], 10),
            minutes: estimate.minutes[0].toLowerCase() !== 'leaving' ? parseInt(estimate.minutes[0], 10) : -1, // use -1 to designate `LEAVING`
            platform: parseInt(estimate.platform[0], 10),
          })).sort((a, b) => a.minutes - b.minutes),
        }));
        return map;
      }, {})
    );
}

function computeAverageTimeBetweenStations(routes, schedules = null) {
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
  constructor(id, initialEtd) {
    assert(initialEtd, 'Train must be initialized with an estimate');
    this.id = id;
    this.length = initialEtd.length;
    this.updates = [];

    this.update(initialEtd);
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
        const id = this.addTrain(etd);
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
          const id = this.addTrain(etd);
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
          segmentsToTrains[stationsKey].push(estimate);
          const progress = estimate.minutes === -1 ? 1 : estimate.minutes / avgTravelTime;
          const trainPosition = {
            lat: nextStation.lat - (progress * (nextStation.lat - station.lat)),
            lng: nextStation.lng - (progress * (nextStation.lng - station.lng)),
          };
          const headingRadians = Math.atan2(trainPosition.lng - station.lng, trainPosition.lat - station.lat);

          // debug(`Train ${ stationsKey } in ${ estimate.minutes }min (avg: ${ avgTravelTime.toFixed(2) }min) resolved to ${ trainPosition.lat.toFixed(2) }, ${ trainPosition.lng.toFixed(2) } @ ${ (headingRadians * 180 / Math.PI).toFixed(2) }`);
        });
      });
    });
    debug(`[${ moment().format() }] done`);

    Object.keys(segmentsToTrains).forEach(key => segmentsToTrains[key].sort((a, b) => a.minutes - b.minutes));
    return segmentsToTrains;
  }

  addTrain(etd) {
    const id = this.trainCounter++;
    this.trains.set(id, new Train(id, etd));
    return id;
  }
}

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
