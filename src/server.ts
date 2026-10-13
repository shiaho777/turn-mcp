#!/usr/bin/env node
import { createApp, listen } from './app.js';

const app = createApp();
listen(app);
