import { expect, test } from 'bun:test';
import { ChatTypingHandler } from './ChatTypingHandler';

function fixture() {
    let paused = false;
    let scrolling = true;
    const keyboard = { pause: () => { paused = true; }, unpause: () => { paused = false; } };
    const scroll = { pause() {}, unpause() {}, cancel: () => { scrolling = false; } };
    const messages = { isComposing: false };
    const history = { lastComposeTarget: { value: { type: 0, name: 'team' } } };
    const handler = new ChatTypingHandler(keyboard, scroll, messages, history);
    const press = (key: string, options = {}) => handler.handleKeyDown({ key, preventDefault() {}, ...options } as KeyboardEvent);
    return {handler, press, messages, history, paused:()=>paused, scrolling:()=>scrolling};
}

test('Enter opens chat with the remembered audience and cancels held scrolling', () => {
    const f = fixture();
    expect(f.press('Enter')).toBe(true);
    expect(f.messages.isComposing).toBe(true);
    expect(f.history.lastComposeTarget.value.name).toBe('team');
    expect(f.paused()).toBe(true);
    expect(f.scrolling()).toBe(false);
    expect(f.press('a')).toBe(true);
    f.handler.endTyping();
    expect(f.paused()).toBe(false);
    expect(f.messages.isComposing).toBe(false);
});

test('chat does not open on repeated, modified, IME or text-field Enter', () => {
    for (const options of [{repeat:true}, {ctrlKey:true}, {metaKey:true}, {isComposing:true}, {target:{matches:()=>true}}]) {
        const f = fixture();
        expect(f.press('Enter', options)).toBe(false);
        expect(f.messages.isComposing).toBe(false);
    }
});
