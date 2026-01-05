#!/usr/bin/env bun
import { initDatabase } from './index';

console.log('Initializing database...');
initDatabase('./orchestrator.db');
console.log('Database initialized successfully.');
