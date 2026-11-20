import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

/**
 * Complete reactive agent, combining the pieces of this lab:
 * - one_move.js:   condition -> action rules, position updated from emitMove
 * - blind_pick.js: no memory about parcels, target re-selected after every step
 *
 * Unlike blind_move.js it is not blind: it looks at the map to choose the
 * next step, so walls do not trap it. It is still reactive: no plan is stored,
 * everything is recomputed from the current perception after every action.
 *
 * At every iteration the first rule whose condition holds fires:
 * 1. carrying parcels and standing on a delivery tile -> put down
 * 2. standing on a free parcel                        -> pick up
 *    (if nothing gets picked up I am full: ignore free parcels until I deliver)
 * 3. carrying parcels and no free parcel is closer
 *    than the nearest delivery tile                   -> one step toward that delivery tile
 * 4. a free parcel is perceived                       -> one step toward the best one
 * 5. otherwise, or when the step fails                -> one random step (explore)
 */

const socket = DjsConnect();

/** @typedef { 'up' | 'right' | 'left' | 'down' } Direction */
/** @type { {direction:Direction, dx:number, dy:number}[] } */
const MOVES = [
    { direction: 'up',    dx:  0, dy:  1 },
    { direction: 'right', dx:  1, dy:  0 },
    { direction: 'down',  dx:  0, dy: -1 },
    { direction: 'left',  dx: -1, dy:  0 },
];

/** @type { function ({x:number, y:number}): string } */
const key = ( {x, y} ) => `${x}_${y}`;



/**
 * Beliefs
 */

/** @type { {id:string, name:string, x:number, y:number, score:number} } */
const me = {id: '', name: '', x: -1, y: -1, score: 0};

/** Parcels currently perceived
 * @type { Map< string, {id:string, carriedBy?:string, x:number, y:number, reward:number} > } */
const parcels = new Map();

/** Tiles currently occupied by other agents
 * @type { Set<string> } */
const occupied = new Set();

/** Walkable tiles of the map
 * @type { Set<string> } */
const walkable = new Set();

/** @type { {x:number, y:number}[] } */
var deliveryTiles = [];

socket.onMap( ( width, height, tiles ) => {
    walkable.clear();
    for ( const t of tiles ) {
        if ( String(t.type) != '0' ) walkable.add( key(t) );   // '0' is a wall
    }
    // '2' delivery, '9' double delivery
    deliveryTiles = tiles.filter( t => [ '2', '9' ].includes( String(t.type) ) );
    console.log( 'map', width, 'x', height, 'with', deliveryTiles.length, 'delivery tiles' );
} );

socket.onSensing( ( sensing ) => {

    const { self } = sensing;
    if ( self ) {
        me.id = self.id;
        me.name = self.name;
        me.score = self.score;
        // while moving, coordinates are fractional: keep the last integer tile
        if ( self.x != undefined && self.y != undefined && self.x % 1 == 0 && self.y % 1 == 0 ) {
            me.x = self.x;
            me.y = self.y;
        }
    }

    // reactive agent: beliefs are only what is currently perceived
    parcels.clear();
    for ( const p of sensing.parcels ) {
        parcels.set( p.id, p );
    }
    occupied.clear();
    for ( const a of sensing.agents ) {
        if ( a.id == me.id || a.x == undefined || a.y == undefined ) continue;
        // a moving agent is in between two tiles: both are busy
        occupied.add( key( { x: Math.floor(a.x), y: Math.floor(a.y) } ) );
        occupied.add( key( { x: Math.ceil(a.x), y: Math.ceil(a.y) } ) );
    }

} );



/**
 * Reasoning
 */

/**
 * Breadth-first search from my position over walkable tiles not occupied by
 * other agents. For every reachable tile it gives the number of steps and
 * the first move of a shortest path to it.
 * @returns { Map< string, {steps:number, first?:Direction} > }
 */
function reachable () {
    /** @type { Map< string, {steps:number, first?:Direction} > } */
    const found = new Map( [ [ key(me), { steps: 0 } ] ] );
    const queue = [ { x: me.x, y: me.y } ];
    while ( queue.length ) {
        const tile = /** @type { {x:number, y:number} } */ ( queue.shift() );
        const here = /** @type { {steps:number, first?:Direction} } */ ( found.get( key(tile) ) );
        for ( const { direction, dx, dy } of MOVES ) {
            const next = { x: tile.x + dx, y: tile.y + dy };
            const k = key(next);
            if ( found.has(k) || ! walkable.has(k) || occupied.has(k) ) continue;
            found.set( k, { steps: here.steps + 1, first: here.first ?? direction } );
            queue.push( next );
        }
    }
    return found;
}



/**
 * Actions
 */

/**
 * Resolves at the next sensing event, so that beliefs are up to date
 * with the effects of my last action before deciding again
 * @returns { Promise<void> }
 */
function nextSensing () {
    return new Promise( res => {
        const listener = () => {
            socket.off( "sensing", listener );
            res();
        };
        socket.onSensing( listener );
    } );
}

/**
 * Try one move; on success update my position from the server reply
 * @param { Direction } direction
 * @returns { Promise<boolean> } false if the server refused the move
 */
async function move ( direction ) {
    try {
        const moved = await socket.emitMove( direction );
        if ( moved ) {
            me.x = moved.x;
            me.y = moved.y;
            return true;
        }
    } catch (e) {
        // no acknowledgement within the timeout: the move may still be going on,
        // so wait for a fresh perception and decide again instead of moving elsewhere
        await nextSensing();
        return true;
    }
    return false;
}

/**
 * One step in a random direction, used to explore and to get unstuck
 * @returns { Promise<boolean> } true if moved
 */
async function randomStep () {
    const shuffled = MOVES
        .filter( ( {dx, dy} ) => walkable.has( key( { x: me.x + dx, y: me.y + dy } ) ) )
        .sort( () => Math.random() - 0.5 );
    for ( const { direction } of shuffled ) {
        if ( await move( direction ) ) return true;
    }
    return false;
}



/**
 * Control loop
 */

// set when a pickup fails although a free parcel is on my tile: I cannot carry more
var full = false;

while ( true ) {

    // wait for the first perception of myself and of the map
    if ( ! me.id || me.x < 0 || ! walkable.size ) {
        await new Promise( res => setTimeout( res, 100 ) );
        continue;
    }

    const carried = Array.from( parcels.values() ).filter( p => p.carriedBy == me.id );
    if ( ! carried.length ) full = false;
    // when full, free parcels are ignored: the only thing left to do is delivering
    const free = full ? [] : Array.from( parcels.values() ).filter( p => ! p.carriedBy );
    const onDelivery = deliveryTiles.some( t => t.x == me.x && t.y == me.y );

    try {

        // 1. deliver
        if ( carried.length && onDelivery ) {
            const dropped = await socket.emitPutdown();
            console.log( `me(${me.x},${me.y})`, 'delivered', dropped.length, 'parcels' );
            await nextSensing();
            continue;
        }

        // 2. pick up
        if ( free.some( p => p.x == me.x && p.y == me.y ) ) {
            const picked = await socket.emitPickup();
            console.log( `me(${me.x},${me.y})`, 'picked up', picked.length, 'parcels' );
            if ( ! picked.length && carried.length ) full = true;
            await nextSensing();
            continue;
        }

    } catch (e) {
        // no acknowledgement from the server within the timeout: re-evaluate
        continue;
    }

    const paths = reachable();
    /** @type { function ({x:number, y:number}): number } */
    const steps = ( tile ) => paths.get( key(tile) )?.steps ?? Infinity;

    // 3. bring what I carry to the nearest delivery tile,
    //    unless a free parcel is closer than that: then pick it on the way
    const delivery = carried.length
        ? deliveryTiles
            .filter( t => steps(t) < Infinity )
            .sort( (a, b) => steps(a) - steps(b) )
            .shift()
        : undefined;

    // 4. go to the best free parcel, weighing reward against distance
    const score = ( p ) => p.reward - steps(p);
    const best = free
        .filter( p => steps(p) < ( delivery ? steps(delivery) : Infinity ) )
        .sort( (a, b) => score(b) - score(a) )
        .shift();

    const target = best ?? delivery;
    const direction = target ? paths.get( key(target) )?.first : undefined;

    let moved = false;
    if ( target && direction ) {
        console.log( `me(${me.x},${me.y})`, best ? 'to parcel' : 'to delivery', `(${target.x},${target.y})`, 'carrying', carried.length );
        moved = await move( direction );
    }

    // 5. nothing to do, or the step failed: random step
    if ( ! moved ) {
        moved = await randomStep();
    }

    // completely stuck: avoid a busy loop
    if ( ! moved ) {
        await new Promise( res => setTimeout( res, 100 ) );
    }

}
