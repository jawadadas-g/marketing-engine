import { render } from 'preact';
import { App } from './app.js';
import './style.css';

const root = document.getElementById('app');
if (!root) throw new Error('no #app to render into');
render(<App />, root);
