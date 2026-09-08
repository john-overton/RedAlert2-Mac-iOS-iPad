import { expect, test } from 'bun:test';
import { MessageList } from './MessageList';

test('chat panel retains only the last ten chat messages after HUD notices expire', () => {
    const list = new MessageList(10, 5, undefined);
    for (let i = 0; i < 12; i++) list.addChatMessage(`message ${i}`, 'red');
    list.addSystemMessage('system notice', 'white');
    list.addUiFeedbackMessage('selection notice');
    for (const message of list.getAll()) message.time -= 11000;
    list.prune();
    expect(list.getAll()).toEqual([]);
    expect(list.getRecentChatMessages().map(message => message.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `message ${i + 2}`),
    );
    expect(list.getRecentChatMessages().every(message => message.color === 'red')).toBe(true);
});
