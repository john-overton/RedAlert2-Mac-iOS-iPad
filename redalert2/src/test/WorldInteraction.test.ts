import { expect, mock, test } from 'bun:test';
import { WorldInteraction } from '../gui/screen/game/worldInteraction/WorldInteraction';
import { ActionFilter } from '../gui/screen/game/worldInteraction/ActionFilter';

function setup(rightClickMove = true) {
    const interaction = new (WorldInteraction as any)();
    const hover = { gameObject: {} };
    const execute = mock((..._args: any[]) => {});
    const deselectAll = mock(() => {});
    Object.assign(interaction, {
        worldScene: { viewport: { x: 0, y: 0, width: 800, height: 600 } },
        mapScrollHandler: { cancel() {} },
        pointerEvents: {},
        rightClickMove: { value: rightClickMove },
        rightClickScroll: { value: false },
        mapHoverHandler: { update() {}, getCurrentHover: () => hover },
        unitSelectionHandler: {
            deselectAll, getHash: () => 'selection', getSelectedUnits: () => [],
            finishBoxSelect: mock(() => true),
        },
        defaultActionHandler: { execute },
    });
    const click = (button: number, extra = {}) => {
        const event = { button, pointer: { x: 10, y: 10 }, timeStamp: 100, ...extra };
        interaction.handleMouseDown(event);
        interaction.handleMouseUp(event);
    };
    return { interaction, execute, deselectAll, click };
}

test('left click selects with right-click orders enabled', () => {
    const { click, execute } = setup();
    click(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2]).toBe(ActionFilter.SelectOnly);
});

test('right click issues orders without selecting', () => {
    const { click, execute, deselectAll } = setup();
    click(2);
    expect(execute.mock.calls[0][2]).toBe(ActionFilter.NoSelect);
    expect(deselectAll).not.toHaveBeenCalled();
});

test('shift-left click preserves selection for toggle selection', () => {
    const { click, execute, deselectAll } = setup();
    click(0, { shiftKey: true });
    expect(deselectAll).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][2]).toBe(ActionFilter.SelectOnly);
    expect(execute.mock.calls[0][5].shiftKey).toBe(true);
});

test('completed box selection is not cleared or replaced by a click', () => {
    const { interaction, execute, deselectAll } = setup();
    const event = { button: 0, pointer: { x: 10, y: 10 }, timeStamp: 100 };
    interaction.handleMouseDown(event);
    interaction.hasDragged = true;
    interaction.handleMouseUp(event);
    expect(interaction.unitSelectionHandler.finishBoxSelect).toHaveBeenCalled();
    expect(deselectAll).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
});

test('classic left-click orders and right-click deselect remain available', () => {
    const { click, execute, deselectAll } = setup(false);
    click(0);
    expect(execute.mock.calls[0][2]).toBe(ActionFilter.All);
    click(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deselectAll).toHaveBeenCalled();
});
