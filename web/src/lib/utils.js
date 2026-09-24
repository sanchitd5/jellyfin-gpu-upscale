/* Shared, dependency-free predicates used across the engine and the panel. */
export function isOff(v) {
    return v == null || v === '' || v === 'off' || v === false;
}
