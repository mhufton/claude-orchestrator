#!/usr/bin/env bun
import { initDatabase } from './index';
import { DB_PATH } from '../config';

console.log('Initializing database...');
initDatabase(DB_PATH);
console.log('Database initialized successfully.');
