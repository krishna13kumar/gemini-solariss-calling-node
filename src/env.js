/**
 * Strict environment configuration loader.
 * No fallbacks for required keys — fail fast at startup, not mid-call.
 */

import dotenv from 'dotenv';
dotenv.config();

export function getRequiredEnv(key) {
  const value = process.env[key];
  if (value === undefined || value === null || value.trim() === '') {
    throw new Error(`[Fatal Configuration Error] Missing required environment variable: ${key}.`);
  }
  return value.trim();
}

export function getEnv(key, fallback) {
  const value = process.env[key];
  return value === undefined || value === null || value.trim() === '' ? fallback : value.trim();
}

export function getBoolEnv(key, fallback = false) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}
