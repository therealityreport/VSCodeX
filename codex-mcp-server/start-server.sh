#!/usr/bin/env bash
export $(grep -v '^#' .env | xargs)
npm run dev
