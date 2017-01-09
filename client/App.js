import React, { Component } from 'react';
import './App.css';
import GoogleMap from './google-map';

import ApolloClient, { createNetworkInterface } from 'apollo-client';
import { ApolloProvider } from 'react-apollo';

const host = process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:3001';
const client = new ApolloClient({
  networkInterface: createNetworkInterface({ uri: `${ host }/graphql` }),
});

class App extends Component {

  render() {
    return (
      <ApolloProvider client={ client }>
        <div className="App">
          <GoogleMap />
        </div>
      </ApolloProvider>
    );
  }
}

export default App;
