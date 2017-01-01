import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import './index.css';
import 'graphiql/graphiql.css';

import GraphiQL from 'graphiql';
import fetch from 'isomorphic-fetch';

const rootEl = document.getElementById('root');

if (window.location.pathname.startsWith('/graphiql')) {
  function graphQLFetcher(graphQLParams) {
    return fetch(`http://localhost:3001/graphql`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphQLParams),
    }).then(response => response.json());
  }

  ReactDOM.render(<GraphiQL fetcher={ graphQLFetcher } />, rootEl);
} else {
  ReactDOM.render(<App />, rootEl);
}
