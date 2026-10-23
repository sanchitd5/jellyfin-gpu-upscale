import { state } from '../model/state.js';
import { player, activePlayer } from './live-apply.js';

/*
 * THE ITEM THE PLAYER IS ON, found by shape through the playbackManager the plugin already holds
 * (state.playbackManagerRef, else live-apply's player()). Null when there is no active player or
 * the manager does not have the methods: callers treat null as "hide yourself".
 */
export function currentItem() {
    try {
        var pm = state.playbackManagerRef || player();
        var pl = pm && typeof pm.currentItem === 'function' ? activePlayer(pm) : null;
        return (pl && pm.currentItem(pl)) || null;
    } catch (err) {
        // currentItem() throws when there is no active player.
        return null;
    }
}
