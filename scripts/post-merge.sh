#!/bin/bash
set -e

npm install --legacy-peer-deps
node scripts/migrate.js
