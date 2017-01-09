import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import GoogleMapsLoader from 'google-maps';
import { graphql, compose } from 'react-apollo';
import gql from 'graphql-tag';
import moment from 'moment';

class GoogleMap extends Component {

  constructor(props) {
    super(props);
    this.markers = [];
  }

  componentWillMount() {
    GoogleMapsLoader.load(google => {
      const node = ReactDOM.findDOMNode(this.refs.map);
      this.google = google;
      this.map = new google.maps.Map(node, {
        zoom: 10,
        center: { lat: 37.8014184, lng: -122.333682 },
      });

      if (!this.props.loading) {
        this.renderStationsAndTrains(this.props.stations, this.props.trains);
      }
    });
  }

  componentWillReceiveProps(nextProps) {
    if (this.google && !nextProps.loading) {
      this.renderStationsAndTrains(nextProps.stations, nextProps.trains, nextProps.routes);
    }
  }

  renderStationsAndTrains = (stations, trains, routes) => {

    this.markers.forEach(marker => marker.setMap(null));

    const google = this.google;
    stations.forEach(station => {
      this.markers.push(new google.maps.Marker({
        map: this.map,
        position: { lat: station.lat, lng: station.lng },
        title: station.name,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 4,
        },
      }));
    });

    trains.forEach(train => {
      const latestUpdate = Array.from(train.updates).sort((a, b) => b.timestamp - a.timestamp)[0];
      const info = `${ train.origin.id }-${ train.destination.id } in ${ latestUpdate.minutes } minutes (avg: ${ train.averageMinutes.toFixed(2) } minutes)`;
      const progress = latestUpdate.minutes === -1 ? 1 : latestUpdate.minutes / train.averageMinutes;
      const trainPosition = {
        lat: train.destination.lat - (progress * (train.destination.lat - train.origin.lat)),
        lng: train.destination.lng - (progress * (train.destination.lng - train.origin.lng)),
      };

      const marker = new google.maps.Marker({
        map: this.map,
        position: trainPosition,
        title: info + '\n' +  train.updates.map(update => `${ moment.unix(update.timestamp).format('MM/DD@HH:mm:ss') } - ${ update.minutes }`).join('\n'),
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 3,
          rotation: Math.atan2(trainPosition.lng - train.origin.lng, trainPosition.lat - train.origin.lat) * 180 / Math.PI,
        },
      });
      this.markers.push(marker);
    });

    routes.forEach(route => {
      new google.maps.Polyline({
        map: this.map,
        path: route.points,
        geodesic: true,
        strokeColor: route.color,
        strokeOpacity: 1.0,
        strokeWeight: 2,
      });
    });
  }

  render() {
    return <div className="Map" ref="map" />;
  }
}

const stationsAndTrainsQuery = gql`
  query stationsAndTrains {
    trains {
      id
      updates {
        timestamp
        minutes
      }
      averageMinutes
      cars
      origin { id lat lng }
      destination { id lat lng }
    }
    stations {
      id
      lat
      lng
      name
    }
    routes {
      name
      color
      points {
        lng
        lat
      }
    }
  }
`;

export default compose(
  graphql(stationsAndTrainsQuery, {
    options: { pollInterval: 10000 },
    props: ({ ownProps, data: { loading, stations, trains, routes } }) => ({
      loading,
      stations,
      trains,
      routes,
    }),
  }),
)(GoogleMap);
