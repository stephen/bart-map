import Promise, { promisify } from 'bluebird';
import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import './App.css';
import GoogleMapsLoader from 'google-maps';
import { Parser as XmlParser } from 'xml2js';
import moment from 'moment';
import assert from 'assert';

const parser = new XmlParser();
const parseXmlString = promisify(parser.parseString);
const responseToJson = resp => resp.text().then(resp => parseXmlString(resp));

const BART_BASE_URL = 'https://api.bart.gov/api';
const BART_API_KEY = 'MW9S-E7SL-26DU-VV8V';
const BART_SERVICE_END = moment('2:27 AM', 'hh:mm A');

class GoogleMap extends Component {

  componentWillMount() {
    GoogleMapsLoader.load(google => {
      const node = ReactDOM.findDOMNode(this.refs.map);
      this.map = new google.maps.Map(node, {
        zoom: 10,
        center: { lat: 37.8014184, lng: -122.333682 },
      });

      Promise.all([
        fetchStations(),
        fetchRouteEtds(),
        fetchRoutes().then(routes =>
          Promise.map(routes, route =>
            fetchRouteSchedule(route.number).then(schedule => ({ ...route, schedule }))
          )
        ),
      ]).then(([stations, stationEtds, routes]) => {
        const stationTimes = computeAverageTimeBetweenStations(routes);

        stations.forEach(station => {
          new google.maps.Marker({
            map: this.map,
            position: { lat: station.lat, lng: station.lng },
            title: station.name,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 4,
            },
          });

          // ignore stations without etds, e.g. oakland airport ext.
          if (!stationEtds[station.abbr]) {
            return;
          }

          stationEtds[station.abbr].forEach(line => {
            const dest = line.destinationAbbr;

            const candidateRoutes = routes.filter(route =>
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

            // for now, pick an arbitrary route and arbitrary train on the route
            // that contain the station and the correct destination
            const route = candidateRoutes[0];
            const train = route.schedule.trains[0];

            const nextStop = train.stops[train.stops.findIndex(stop => stop.station === station.abbr) + 1];

            assert(nextStop, `Could not find next stop from ${ station.abbr } on ${ route.abbr }`)
            const nextStation = stations.find(station => station.abbr === nextStop.station);
            const stationsKey = `${ station.abbr }-${ nextStop.station }`;
            const avgTravelTime = stationTimes[route.number][stationsKey];

            // ignore estimates that are probably past this station.
            const nearbyEstimates = line.estimates.filter(estimate => estimate.minutes < avgTravelTime);
            nearbyEstimates.forEach(estimate => {
              const info = `${ stationsKey } in ${ estimate.minutes } minutes (avg: ${ avgTravelTime.toFixed(2) } minutes)`;
              const progress = estimate.minutes === -1 ? 1 : estimate.minutes / avgTravelTime;
              const trainPosition = {
                lat: nextStation.lat - (progress * (nextStation.lat - station.lat)),
                lng: nextStation.lng - (progress * (nextStation.lng - station.lng)),
              };

              new google.maps.Marker({
                map: this.map,
                position: trainPosition,
                title: info,
                icon: {
                  path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                  scale: 3,
                  rotation: Math.atan2(trainPosition.lng - station.lng, trainPosition.lat - station.lat) * 180 / Math.PI,
                },
              });
            });
          });
        });
      });



    });
  }

  render() {
    return <div className="Map" ref="map" />;
  }
}

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

function fetchRouteSchedule(routeNumber) {
  return fetch(`https://api.bart.gov/api/sched.aspx?cmd=routesched&route=${ routeNumber }&key=MW9S-E7SL-26DU-VV8V`)
    .then(responseToJson)
    .then(resp => ({
      trains: resp.root.route[0].train.map(train => ({
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
      date: moment(resp.root.date[0], 'MM/DD/YYYY'),
      scheduleNumber: parseInt(resp.root.sched_num[0], 10),
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
    .then(resp => window.x = resp)
    .then(resp => 
      resp.root.station.reduce((map, station) => {
        map[station.abbr[0]] = station.etd.map(etd => ({
          destinationAbbr: etd.abbreviation[0],
          destination: etd.destination[0],
          estimates: etd.estimate.map(estimate => ({
            bike: estimate.bikeflag[0] === '1',
            cars: parseInt(estimate.length[0], 10),
            minutes: estimate.minutes[0].toLowerCase() !== 'leaving' ? parseInt(estimate.minutes[0], 10) : -1, // use -1 to designate `LEAVING`
            platform: parseInt(estimate.platform[0], 10),
          }))
        }));
        return map;
      }, {})
    );
}

function computeAverageTimeBetweenStations(routes, schedules = null) {
  return routes.reduce((routeMap, route) => {
    const schedule = schedules ? schedules[route.number] : route.schedule;
    const variance = schedule.trains.reduce((map, train) => {
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

    routeMap[route.number] = Object.entries(variance).reduce((map, [key, values]) => {
      map[key] = values.reduce((sum, time) => sum + time, 0) / values.length;
      return map;
    }, {});

    return routeMap;
  }, {});
}

class App extends Component {

  render() {
    return (
      <div className="App">
        <GoogleMap />
      </div>
    );
  }
}

export default App;
