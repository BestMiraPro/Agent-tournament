/**
 * A protected shard gateway's ceilings, charged to its run's capacity reservation on top of its
 * worker's. Dependency-free, so the dashboard's setup estimate counts exactly what the server reserves.
 */
export const GATEWAY_MEMORY = '64m'
export const GATEWAY_MEMORY_BYTES = 64 * 1024 ** 2
export const GATEWAY_CPUS = 0.25
