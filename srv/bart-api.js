import Promise, { promisify } from 'bluebird';
import fetch from "isomorphic-fetch";
import moment from 'moment';
import { Parser as XmlParser } from 'xml2js';

const parser = new XmlParser();
const parseXmlString = promisify(parser.parseString);
const responseToJson = resp => resp.text().then(resp => parseXmlString(resp));

const BART_BASE_URL = 'https://api.bart.gov/api';
const BART_API_KEY = 'MW9S-E7SL-26DU-VV8V';
const BART_SERVICE_END = moment('2:27 AM', 'hh:mm A');

export function fetchRoutes() {
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

export async function fetchRoutesWithSchedules() {
  const routes = await fetchRoutes();
  return await Promise.all(routes.map(route =>
    fetchRouteSchedule(route.number).then(schedule => ({ ...route, schedule }))
  ));
}

export function fetchRouteSchedule(routeNumber) {
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

export function fetchStations() {
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

export function fetchRouteEtds() {
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
