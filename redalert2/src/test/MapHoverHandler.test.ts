import { expect, test } from 'bun:test';
import { MapHoverHandler } from '../gui/screen/game/worldInteraction/MapHoverHandler';
import { TileOccupation } from '../game/map/TileOccupation';
import { EventDispatcher } from '../util/event';

function fixture() {
    const tile = { rx: 12, ry: 18 };
    let groundTile: typeof tile | undefined;
    const building = {
        tile: tile as typeof tile | undefined,
        isBuilding: () => true, getFoundation: () => ({ width: 3, height: 5 }),
    };
    const hovered: boolean[] = [];
    const renderable = { gameObject: building, selectionModel: { setHover: (value: boolean) => hovered.push(value) } };
    const occupation = Object.create(TileOccupation.prototype);
    occupation.tileOccupation = {};
    const onFrame = new EventDispatcher<any, number>();
    const handler = new MapHoverHandler(
        { getEntityAtScreenPoint: () => ({ renderable }) },
        { getTileAtScreenPoint: () => groundTile, intersectTilesByScreenPos: () => [] },
        { tiles: { getByMapCoords: () => undefined }, tileOccupation: occupation },
        undefined, { onFrame },
    );
    return { handler, building, tile, hovered, onFrame, ground: (value: typeof tile | undefined) => { groundTile = value; } };
}

test('large building sprite hit without a ground intersection falls back to its actual tile', () => {
    const { handler, tile } = fixture();
    expect(() => handler.update({ x: 100, y: 100 }, true)).not.toThrow();
    expect(handler.getCurrentHover().tile).toBe(tile);
    expect(handler.getCurrentHover().groundTile).toBeUndefined();
    handler.dispose();
});

test('render-frame hover refresh survives losing the ground hit after building placement', () => {
    const { handler, tile, ground, onFrame } = fixture();
    ground(tile);
    handler.update({ x: 100, y: 100 });
    onFrame.dispatch(undefined, 0);
    ground(undefined);
    expect(() => onFrame.dispatch(undefined, 250)).not.toThrow();
    expect(handler.getCurrentHover().tile).toBe(tile);
    handler.dispose();
});

test('large building keeps the ground tile under the pointer when one exists', () => {
    const { handler, ground } = fixture();
    const pointedTile = { rx: 14, ry: 20 };
    ground(pointedTile);
    handler.update({ x: 100, y: 100 }, true);
    expect(handler.getCurrentHover().tile).toBe(pointedTile);
    handler.dispose();
});

test('an entity with neither ground nor object tile clears the previous hover safely', () => {
    const { handler, building, hovered, ground, tile } = fixture();
    ground(tile);
    handler.update({ x: 100, y: 100 }, true);
    ground(undefined); building.tile = undefined;
    expect(() => handler.update({ x: 100, y: 100 }, true)).not.toThrow();
    expect(handler.getCurrentHover()).toBeUndefined();
    expect(hovered).toEqual([true, false]);
    handler.dispose();
});
