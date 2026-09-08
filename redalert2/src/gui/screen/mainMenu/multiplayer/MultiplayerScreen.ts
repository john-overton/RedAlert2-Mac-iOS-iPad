import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { MainMenuScreenType, ScreenType } from '@/gui/screen/ScreenType';
import { MainMenuRoute } from '@/gui/screen/mainMenu/MainMenuRoute';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { MusicType } from '@/engine/sound/Music';
import { MapDigest } from '@/engine/MapDigest';
import { VirtualFile } from '@/data/vfs/VirtualFile';
import { MAX_CONTENT_BYTES, MAX_CONTENT_FILE_BYTES, type ContentFile } from '@/network/content/ContentPackage';
import { hasSessionContent, mountSessionContent, restoreSessionContent } from '@/network/content/SessionContentResources';
import { MapFile } from '@/data/MapFile';
import { MapPreviewRenderer } from '@/gui/screen/mainMenu/lobby/MapPreviewRenderer';
import { PregameController, PregameMapSelectionResult } from '@/gui/screen/mainMenu/lobby/PregameController';
import { LobbyType, PlayerStatus, SlotOccupation } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { SlotType } from '@/network/gameopt/SlotInfo';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { chatBadge } from '@/gui/screen/game/NetworkChatHandler';
import { RECIPIENT_ALL, RECIPIENT_TEAM, RECIPIENT_OBSERVERS } from '@/network/gservConfig';
import { OBS_TEAM_ID } from '@/game/gameopts/constants';
import { LobbyClient } from '@/network/client/LobbyClient';
import { createMultiplayerIdentity } from '@/network/MultiplayerIdentity';
import type { Session } from '@/network/server/Session';
import { Multiplayer, ConnectionFields } from './Multiplayer';

const RECENT_KEY = 'multiplayer.recentAddresses';
const NAME_KEY = 'multiplayer.playerName';

export class MultiplayerScreen extends MainMenuScreen {
    public title = 'Multiplayer';
    public musicType = MusicType.Intro;
    private form?: any;
    private client?: LobbyClient;
    private pregame: PregameController;
    private busy = false;
    private error?: string;
    private hosting = false;
    private launching = false;
    private backingOut = false;
    private joinRole: 'player' | 'observer' = 'player';
    private observePending = false;
    private observePendingGeneration?: number;
    private autoObserveGeneration?: number;
    private addresses: string[] = [];
    private messages: any[] = [];
    private chatHistory = new ChatHistory();
    private checkedMap?: string;
    private validatedMap?: string;
    private validatedMapFile?: any;
    private active = false;
    private generation = 0;
    private contentStatus?: string;
    private contentBusy = false;
    private contentAbort?: AbortController;
    private uploadAbort?: AbortController;
    private mountedContent?: string;
    private checkingContent?: string;
    private contentRevision = 0;
    private originalMapOpts?: any;
    private fields: ConnectionFields;

    constructor(private rootController: any, private strings: any, private jsxRenderer: any,
        private rules: any, private mapFileLoader: any, private mapList: any,
        private gameModes: any, private localPrefs: any, private messageBoxApi: any,
        _mapDir?: any, private engineType = 'ra2') {
        super();
        this.fields = { playerName: localPrefs.getItem(NAME_KEY) || 'Commander', serverName: 'Red Alert 2 Game', password: '', port: '1620', address: this.recent()[0] || '' };
        this.pregame = new PregameController(strings, rules, mapFileLoader, mapList, gameModes, localPrefs, this.fields.playerName);
    }

    onEnter(): void {
        this.launching = false;
        this.observePending = false;
        this.active = true;
        this.controller.toggleMainVideo(false);
        // Game teardown restores base resources before sibling menu screens are
        // constructed. Remount this room's verified content only when re-entering.
        if (this.mountedContent && !hasSessionContent()) {
            this.mountedContent = undefined;
            this.checkingContent = undefined;
            this.checkedMap = undefined;
            this.validatedMap = undefined;
            this.validatedMapFile = undefined;
        }
        if (this.client?.session) this.onSession(this.client.session);
        this.render();
        this.controller.showSidebarButtons();
        this.refreshPreview();
    }

    onViewportChange(): void {
        this.form = undefined;
        this.render();
        this.refreshPreview();
    }

    private refreshPreview(): void {
        if (!this.active || !this.validatedMapFile) return;
        const preview = new MapPreviewRenderer(this.strings).render(new MapFile(this.validatedMapFile), LobbyType.MultiplayerHost, this.controller.getSidebarPreviewSize());
        this.controller.toggleSidebarPreview(true);
        this.controller.setSidebarPreview(preview);
    }

    async onLeave(): Promise<void> {
        this.active = false;
        if (!this.launching) await this.disconnect();
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    async onStack(): Promise<void> {
        this.active = false;
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    onUnstack(selection?: PregameMapSelectionResult): void {
        this.active = true;
        if (selection && this.client?.session) {
            try {
                this.pregame.applyMapSelection(selection);
                void this.publishSelectedMap(this.pregame.getSnapshot());
            } catch (error) { this.report(error); }
        }
        this.render();
        this.controller.showSidebarButtons();
    }

    private recent(): string[] {
        try {
            const values = JSON.parse(this.localPrefs.getItem(RECENT_KEY) || '[]');
            return Array.isArray(values) ? values.filter(value => typeof value === 'string').slice(0, 5) : [];
        } catch { return []; }
    }

    private async backToMenu(): Promise<void> {
        if (this.backingOut) return;
        this.backingOut = true;
        try {
            await this.controller.popScreen();
            // Returning from a match opens this room as the menu's root screen,
            // so there may be no Home screen underneath it to unstack.
            if (!this.controller.getCurrentScreen()) {
                await this.controller.pushScreen(MainMenuScreenType.Home);
            }
        } finally {
            this.backingOut = false;
        }
    }

    private report(error: unknown): void {
        this.error = error instanceof Error ? error.message : String(error);
        this.render();
    }

    private send(name: string, args: Record<string, unknown> = {}): void {
        try { this.error = undefined; this.client?.command(name, args); }
        catch (error) { this.report(error); }
    }

    private async connect(host: boolean): Promise<void> {
        if (this.busy || this.client?.session) return;
        if (!this.fields.playerName.trim()) { this.report('Enter a player name.'); return; }
        this.busy = true;
        this.error = undefined;
        const generation = ++this.generation;
        this.render();
        try {
            const identity = await createMultiplayerIdentity(this.engineType);
            if (generation !== this.generation) return;
            let address = this.fields.address.trim();
            if (host) {
                const shell = (window as any).__RA2_SHELL__;
                if (!shell?.hostGame) throw new Error('Hosting is not supported in this build yet.');
                const port = Number(this.fields.port);
                if (!/^\d+$/.test(this.fields.port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535.');
                if (!this.pregame.isInitialized()) await this.pregame.initialize();
                if (generation !== this.generation) return;
                this.pregame.updateSelfName(this.fields.playerName.trim());
                const snapshot = this.pregame.getSnapshot();
                // Hosting starts with free seats; commanders may add bots in the lobby.
                snapshot.slotsInfo = snapshot.slotsInfo.map((slot, index) => index === 0 ? slot : { type: index < snapshot.gameOpts.maxSlots ? SlotType.Open : SlotType.Closed });
                snapshot.gameOpts.aiPlayers = snapshot.gameOpts.aiPlayers.map(() => undefined);
                const result = await shell.hostGame({ identity, gameOpts: snapshot.gameOpts, slotsInfo: snapshot.slotsInfo,
                    countryCount: this.rules.getMultiplayerCountries().length,
                    serverName: this.fields.serverName.trim() || 'Red Alert 2 Game', password: this.fields.password, port });
                this.hosting = true;
                if (generation !== this.generation) { await shell.stopHosting(); this.hosting = false; return; }
                this.addresses = result.addresses.map((value: string) => `${value.includes(':') ? `[${value}]` : value}:${result.port}`);
                address = `127.0.0.1:${result.port}`;
            }
            const client = new LobbyClient();
            this.client = client;
            client.onSession.subscribe(this.onSession);
            client.connection.onReconnecting.subscribe(reconnecting => {
                if (this.active && client === this.client) this.form?.applyOptions((options: any) => { options.reconnecting = reconnecting; });
            });
            client.onConnectionHealth.subscribe(health => {
                // Ping updates must not rehydrate map content, close selectors,
                // or rebuild the sidebar while a commander edits the lobby.
                if (this.active && client === this.client) this.form?.applyOptions((options: any) => { options.connectionHealth = health; });
            });
            client.onChat.subscribe(message => {
                const name = message.sender.name;
                const recipient = typeof message.to === 'number' ? message.recipient?.name || 'Commander' : message.to === 'team' ? RECIPIENT_TEAM : message.to === 'observers' ? RECIPIENT_OBSERVERS : RECIPIENT_ALL;
                this.messages = [...this.messages, { from: name, to: { type: typeof message.to === 'number' ? ChatRecipientType.Whisper : ChatRecipientType.Channel, name: recipient }, text: message.text, time: new Date(), sender: { ...message.sender }, recipient: message.recipient ? { ...message.recipient } : undefined,
                    badge: chatBadge(message.to, message.sender.teamId), senderColor: [...this.rules.getMultiplayerColors().values()][message.sender.colorId]?.asHexString() ?? '#fff' }].slice(-180);
                this.render();
            });
            client.onError.subscribe(error => {
                if (client !== this.client) return;
                this.observePending = false;
                if (error.disconnected || error.code === 'disconnected' || error.code === 'kicked') {
                    void this.disconnect().then(() => this.report(error));
                } else this.report(error);
            });
            client.onStartGame.subscribe(() => {
                const match = client.getMatchSession();
                this.observePending = false;
                this.autoObserveGeneration = match.start.generation;
                this.launching = true;
                this.rootController.goToScreen(ScreenType.Game, { create: true, lanLaunch: match.getLaunchDescriptor(),
                    lanMatchSession: match, persistentRoom: true, returnTo: new MainMenuRoute(MainMenuScreenType.Multiplayer, {}) });
            });
            await client.connect(address, { ...identity, type: 'hello', name: this.fields.playerName.trim(), password: this.fields.password, role: host ? 'player' : this.joinRole });
            if (generation !== this.generation || client !== this.client) { client.close(); return; }
            if (host && !client.session!.gameOpts.mapOfficial) {
                await this.publishSelectedMap(this.pregame.getSnapshot());
            }
            this.localPrefs.setItem(NAME_KEY, this.fields.playerName.trim());
            if (!host) {
                // Store addresses only: a password-bearing join URL must not enter preferences.
                const recentAddress = address.replace(/\?.*$/, '');
                this.localPrefs.setItem(RECENT_KEY, JSON.stringify([recentAddress, ...this.recent().filter(value => value !== recentAddress)].slice(0, 5)));
            }
        } catch (error) {
            await this.disconnect();
            this.report(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private onSession = (session: Session): void => {
        if (session.state !== 'started' || session.generation !== this.observePendingGeneration) this.observePending = false;
        this.hydrateSession(session);
        this.render();
        if (this.active && !this.launching) void this.checkContent(session).then(() => {
            const current = this.client?.session;
            const self = current?.clients.find(member => member.id === this.client?.clientId);
            if (this.active && current?.state === 'started' && self?.role === 'observer'
                && this.autoObserveGeneration !== current.generation && this.canObserve(current)) {
                this.autoObserveGeneration = current.generation;
                this.observeGame();
            }
        });
    };

    private canObserve(session: Session): boolean {
        const self = session.clients.find(member => member.id === this.client?.clientId);
        return Boolean(session.state === 'started' && session.allowSpectators && !session.observationUnavailable
            && self?.role !== 'player' && self?.mapReady && this.validatedMap === session.gameOpts.mapDigest
            && !this.contentBusy && (!session.content || (self.contentReady === session.content.id && this.mountedContent === session.content.id)));
    }

    private observeGame(): void {
        const session = this.client?.session;
        if (!session || !this.canObserve(session) || this.observePending) return;
        this.observePending = true;
        this.observePendingGeneration = session.generation;
        this.error = undefined;
        this.render();
        try { this.client!.observeGame(); }
        catch (error) { this.observePending = false; this.report(error); }
    }

    private async publishSelectedMap(snapshot: any): Promise<void> {
        const client = this.client;
        const generation = this.generation;
        if (!client?.session || this.contentBusy) return;
        const abort = this.uploadAbort = new AbortController();
        this.contentBusy = true; this.render();
        const current = () => !abort.signal.aborted && client === this.client && generation === this.generation;
        try {
            if (!snapshot.gameOpts.mapOfficial) {
                this.originalMapOpts ??= { ...client.session.gameOpts };
                const map = snapshot.currentMapFile ?? await this.mapFileLoader.load(snapshot.gameOpts.mapName);
                if (!current()) return;
                const existing = client.session.content;
                const files = existing ? await client.downloadContent(existing, undefined, abort.signal) : [];
                if (!current()) return;
                await client.publishContent([...files.filter(file => !/\.(map|mpr|yrm)$/i.test(file.path)),
                    { path: snapshot.gameOpts.mapName.toLowerCase(), bytes: map.getBytes() }], undefined, abort.signal);
            }
            if (current()) client.command('map', { gameOpts: snapshot.gameOpts });
        } catch (error) { if (current()) this.report(error); }
        finally {
            if (this.uploadAbort === abort) {
                this.uploadAbort = undefined;
                if (!this.checkingContent || this.mountedContent === this.checkingContent) this.contentBusy = false;
                this.render();
            }
        }
    }

    private async importContent(realFiles: File[]): Promise<void> {
        const client = this.client;
        if (!realFiles.length || !client?.session || this.contentBusy) return;
        const abort = new AbortController();
        this.uploadAbort?.abort(); this.uploadAbort = abort;
        this.contentBusy = true; this.contentStatus = 'Preparing host content…'; this.render();
        try {
            if (realFiles.length > 256 || realFiles.some(file => file.size > MAX_CONTENT_FILE_BYTES) || realFiles.reduce((sum, file) => sum + file.size, 0) > MAX_CONTENT_BYTES) {
                throw new Error('Content is limited to 256 files, 32 MiB per file and 64 MiB per package.');
            }
            const files: ContentFile[] = await Promise.all(realFiles.map(async file => ({ path: file.name.toLowerCase(), bytes: new Uint8Array(await file.arrayBuffer()) })));
            if (abort.signal.aborted || client !== this.client) return;
            const maps = files.filter(file => /\.(map|mpr|yrm)$/.test(file.path));
            if (maps.length > 1) throw new Error('Select one custom map per package.');
            let opts = { ...client.session.gameOpts };
            if (maps.length) {
                const file = VirtualFile.fromBytes(maps[0].bytes, maps[0].path);
                const map = new MapFile(file);
                const maxSlots = map.startingLocations.length;
                if (maxSlots < 2 || maxSlots > 8) throw new Error('Custom multiplayer maps must have 2–8 starting locations.');
                if (client.session.clients.some(member => member.slotIndex !== null && member.slotIndex >= maxSlots)) throw new Error('Move players before choosing a smaller map.');
                this.originalMapOpts ??= { ...opts };
                opts = { ...opts, mapName: file.filename, mapTitle: map.getSection('Basic')?.getString('Name') || file.filename,
                    mapDigest: MapDigest.compute(file), mapSizeBytes: file.getSize(), mapOfficial: false, maxSlots };
            } else if (!opts.mapOfficial) {
                const file = await this.mapFileLoader.load(opts.mapName);
                files.push({ path: opts.mapName.toLowerCase(), bytes: file.getBytes() });
            }
            this.contentStatus = 'Uploading host content…'; this.render();
            await client.publishContent(files, undefined, abort.signal);
            if (abort.signal.aborted || client !== this.client) return;
            this.send('map', { gameOpts: opts });
        } catch (error) { if (client === this.client) this.report(error); }
        finally { if (this.uploadAbort === abort) { this.uploadAbort = undefined; if (!this.checkingContent || this.mountedContent === this.checkingContent) this.contentBusy = false; this.render(); } }
    }

    private async removeContent(): Promise<void> {
        const client = this.client;
        const generation = this.generation;
        if (!client?.session) return;
        this.cancelContent();
        const abort = this.uploadAbort = new AbortController();
        const originalMapOpts = this.originalMapOpts;
        this.contentBusy = true; this.render();
        try {
            await client.publishContent([], undefined, abort.signal);
            if (abort.signal.aborted || client !== this.client || generation !== this.generation) return;
            if (originalMapOpts) client.command('map', { gameOpts: originalMapOpts });
            this.originalMapOpts = undefined;
        } catch (error) { if (client === this.client) this.report(error); }
        finally {
            if (this.uploadAbort === abort) {
                this.uploadAbort = undefined;
                if (!this.checkingContent || this.mountedContent === this.checkingContent) this.contentBusy = false;
                this.render();
            }
        }
    }

    private cancelContent(): void {
        this.contentAbort?.abort(); this.uploadAbort?.abort(); this.contentRevision++;
        this.contentBusy = false;
        this.contentStatus = 'Content transfer cancelled. Verify Content to retry.';
        this.render();
    }

    private async checkContent(session: Session, retry = false): Promise<void> {
        const client = this.client;
        if (!client) return;
        const manifest = session.content;
        if (!manifest) {
            if (this.mountedContent) restoreSessionContent();
            this.mountedContent = undefined;
            await this.checkMap(session); return;
        }
        const self = session.clients.find(member => member.id === client.clientId);
        if (!retry && this.mountedContent === manifest.id) {
            if (self?.contentReady !== manifest.id) client.contentReady(manifest.id);
            await this.checkMap(session); return;
        }
        if (!retry && this.checkingContent === manifest.id) return;
        this.contentAbort?.abort();
        const abort = this.contentAbort = new AbortController();
        const revision = ++this.contentRevision;
        this.checkingContent = manifest.id;
        this.contentBusy = true;
        this.contentStatus = `Downloading content (${manifest.totalBytes.toLocaleString()} bytes)…`;
        this.render();
        try {
            const files = await client.downloadContent(manifest, (received, total) => {
                if (revision !== this.contentRevision) return;
                this.contentStatus = `Downloading content: ${received.toLocaleString()} / ${total.toLocaleString()} bytes`;
                this.render();
            }, abort.signal);
            if (abort.signal.aborted || revision !== this.contentRevision || client !== this.client || client.session?.content?.id !== manifest.id) return;
            restoreSessionContent();
            mountSessionContent(new Map(files.map(file => [file.path, file.bytes])), { strings: this.strings, sound: (this.controller as any).sound });
            this.mountedContent = manifest.id;
            this.checkedMap = undefined; this.validatedMap = undefined; this.validatedMapFile = undefined;
            this.contentStatus = `Content verified: ${manifest.files.length} files (${manifest.totalBytes.toLocaleString()} bytes)`;
            this.error = undefined;
            client.contentReady(manifest.id);
            await this.checkMap(client.session!);
        } catch (error) {
            if (revision === this.contentRevision && client === this.client) {
                this.contentStatus = 'Content unavailable. Verify Content to retry.';
                this.report(error);
            }
        } finally {
            if (revision === this.contentRevision) { this.contentBusy = false; this.render(); }
        }
    }

    private hydrateSession(session: Session): void {
        if (this.validatedMap !== session.gameOpts.mapDigest) {
            this.validatedMap = undefined;
            this.validatedMapFile = undefined;
        }
        // Session updates (including ping and readiness) must retain the verified
        // file: selecting the current map reuses it instead of loading it again.
        this.pregame.hydrate({ gameOpts: session.gameOpts, slotsInfo: session.slots,
            currentMapFile: this.validatedMapFile });
    }

    private async checkMap(session: Session): Promise<void> {
        const digest = session.gameOpts.mapDigest;
        if (this.checkedMap === digest) {
            const self = session.clients.find(member => member.id === this.client?.clientId);
            if (this.validatedMap === digest && self && !self.mapReady) this.send('map_ready', { digest });
            return;
        }
        this.checkedMap = digest;
        this.validatedMap = undefined;
        this.validatedMapFile = undefined;
        const client = this.client;
        try {
            const file = await this.mapFileLoader.load(session.gameOpts.mapName);
            if (client !== this.client || this.checkedMap !== digest) return;
            if (MapDigest.compute(file) !== digest) throw new Error('The loaded map differs from the selected host map.');
            this.validatedMap = digest;
            this.validatedMapFile = file;
            this.hydrateSession(client!.session!);
            this.send('map_ready', { digest });
            const preview = new MapPreviewRenderer(this.strings).render(new MapFile(file), LobbyType.MultiplayerHost, this.controller.getSidebarPreviewSize());
            if (this.active) {
                this.controller.toggleSidebarPreview(true);
                this.controller.setSidebarPreview(preview);
            }
        } catch (error) {
            if (client !== this.client || this.checkedMap !== digest) return;
            this.report(`Map unavailable: ${error instanceof Error ? error.message : error}. The host can share the map through Maps and Custom Units.`);
        }
    }

    private async disconnect(): Promise<void> {
        this.generation++;
        this.contentAbort?.abort(); this.uploadAbort?.abort(); this.contentRevision++;
        restoreSessionContent();
        this.mountedContent = undefined; this.checkingContent = undefined;
        this.contentBusy = false; this.contentStatus = undefined; this.originalMapOpts = undefined;
        this.client?.onSession.unsubscribe(this.onSession);
        this.client?.close();
        this.client = undefined;
        if (this.hosting) await (window as any).__RA2_SHELL__?.stopHosting?.();
        this.hosting = false;
        this.addresses = [];
        this.messages = [];
        this.checkedMap = undefined;
        this.validatedMap = undefined;
        this.validatedMapFile = undefined;
        // A downloaded map belongs to the departed session. A subsequent host
        // starts from local preferences instead of retaining its temporary bytes.
        this.pregame = new PregameController(this.strings, this.rules, this.mapFileLoader,
            this.mapList, this.gameModes, this.localPrefs, this.fields.playerName);
        this.launching = false;
        this.observePending = false;
        this.autoObserveGeneration = undefined;
        this.chatHistory.reset();
        if (this.active) {
            this.controller.setSidebarPreview();
            this.controller.toggleSidebarPreview(false);
        }
    }

    private lobbyProps(session: Session): any {
        const self = session.clients.find(member => member.id === this.client?.clientId);
        const props = this.pregame.createLobbyFormProps({ lobbyType: session.state === 'waiting' && self?.admin && !self.ready ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
            activeSlotIndex: self?.slotIndex ?? -1, messages: this.messages, localUsername: self?.name,
            chatHistory: this.chatHistory, channels: self?.role === 'observer' ? [RECIPIENT_OBSERVERS] : self?.role === 'waiting' || session.state === 'started' ? [RECIPIENT_ALL] : [RECIPIENT_ALL, RECIPIENT_TEAM],
            allowWhispers: self?.role !== 'observer', onSendMessage: (message: any) => {
                const text = typeof message === 'string' ? message : message?.value;
                if (!text?.trim()) return;
                const recipient = message?.recipient;
                let target: 'all' | 'team' | 'observers' | number = self?.role === 'observer' ? 'observers' : recipient?.name === RECIPIENT_TEAM ? 'team' : 'all';
                if (self?.role !== 'observer' && recipient?.type === ChatRecipientType.Whisper) {
                    const member = session.clients.find(member => member.name === recipient.name);
                    if (!member) { this.report('That commander has left the game.'); return; }
                    target = member.id;
                }
                try { this.client?.chat(text.trim(), target); } catch (error) { this.report(error); }
            },
            decoratePlayerSlot: (slot, _info, index) => {
                const member = session.clients.find(value => value.slotIndex === index);
                slot.selectionLocked = Boolean(member);
                if (member) { slot.status = member.ready ? PlayerStatus.Ready : member.admin ? PlayerStatus.Host : PlayerStatus.NotReady; slot.ping = member.ping; }
            },
        });
        // Keep the original RA2 selectors and layout while making the server authoritative.
        for (const [callback, key] of Object.entries({ onToggleShortGame: 'shortGame', onToggleMcvRepacks: 'mcvRepacks',
            onToggleCratesAppear: 'cratesAppear', onToggleSuperWeapons: 'superWeapons', onToggleHostTeams: 'hostTeams',
            onToggleDestroyableBridges: 'destroyableBridges', onToggleMultiEngineer: 'multiEngineer',
            onToggleNoDogEngiKills: 'noDogEngiKills', onToggleBuildOffAlly: 'buildOffAlly', onChangeGameSpeed: 'gameSpeed',
            onChangeCredits: 'credits', onChangeUnitCount: 'unitCount' })) {
            props[callback] = (value: unknown) => this.send('option', { key, value });
        }
        props.onSlotChange = (occupation: SlotOccupation, slotIndex: number, difficulty?: number) => {
            if (session.slots[slotIndex].type === SlotType.Player) return;
            if (occupation === SlotOccupation.Occupied) this.send('slot_bot', { slotIndex, difficulty });
            else this.send(occupation === SlotOccupation.Open ? 'slot_open' : 'slot_close', { slotIndex });
        };
        // Uploaded bot implementations are local assets and cannot be checked/transferred yet.
        for (const key of props.availableAiNames.keys()) if (key.startsWith('Custom')) props.availableAiNames.delete(key);
        props.availablePlayerCountries = props.availablePlayerCountries.filter((name: string) => name !== 'Observer');
        props.observersAllowed = false;
        for (const callback of ['onCountrySelect', 'onColorSelect', 'onStartPosSelect', 'onTeamSelect']) {
            const original = props[callback];
            props[callback] = (value: unknown, slotIndex: number) => {
                try {
                    if (callback === 'onTeamSelect' && value === OBS_TEAM_ID) {
                        this.report('Spectator slots are not available in direct multiplayer yet.');
                        return;
                    }
                    original(value, slotIndex);
                    const opts = this.pregame.getSnapshot().gameOpts;
                    const slot = session.slots[slotIndex];
                    const player = slot.type === SlotType.Ai ? opts.aiPlayers[slotIndex] : opts.humanPlayers.find(player => player.name === slot.name);
                    if (player) this.send('player', { slotIndex, countryId: player.countryId, colorId: player.colorId, startPos: player.startPos, teamId: player.teamId });
                    this.hydrateSession(session);
                } catch (error) { this.report(error); }
            };
        }
        return props;
    }

    private render(): void {
        if (!this.active) return;
        const session = this.client?.session;
        const self = session?.clients.find(member => member.id === this.client?.clientId);
        const canReady = Boolean(session?.state === 'waiting' && self?.role === 'player' && self?.mapReady && !this.contentBusy && (!session?.content || self.contentReady === session.content.id));
        const ready = () => { if (canReady) this.send('state', { ready: !self?.ready }); };
        const props = { fields: this.fields, busy: this.busy, error: this.error, canHost: Boolean((window as any).__RA2_SHELL__?.hostGame),
            lobbyProps: session ? this.lobbyProps(session) : undefined, serverName: session?.serverName, addresses: this.addresses,
            status: session?.state === 'started' ? 'Match in progress — waiting for the next round' : session?.state === 'ended' ? 'Match stopped — waiting for commanders to return' : session ? `${session.clients.filter(member => member.ready).length}/${session.clients.length} ready` : undefined,
            matchRunning: Boolean(session && session.state !== 'waiting'),
            role: self?.role, joinRole: this.joinRole,
            onJoinRole: (role: 'player' | 'observer') => { this.joinRole = role; this.render(); },
            onRole: (role: 'player' | 'observer') => this.send('role', { role }),
            allowObservers: session?.allowSpectators,
            observers: session?.clients.filter(member => member.slotIndex === null).map(member => ({ name: member.name, role: member.role })),
            canObserve: Boolean(session && this.canObserve(session) && !this.observePending),
            observePending: this.observePending, observationUnavailable: session?.observationUnavailable,
            onObserve: () => this.observeGame(), onWait: () => { if (session) this.autoObserveGeneration = session.generation; this.error = undefined; this.render(); },
            contentStatus: this.contentStatus, contentBusy: this.contentBusy,
            canManageContent: session?.state === 'waiting' && self?.admin, hasContent: Boolean(session?.content?.files.length),
            onContentFiles: (files: File[]) => void this.importContent(files), onRemoveContent: () => void this.removeContent(),
            onRetryContent: () => session && void this.checkContent(session, true), onCancelContent: () => this.cancelContent(),
            disconnectAi: session?.gameOpts.disconnectAi, onDisconnectAi: (value: boolean) => this.send('option', { key: 'disconnectAi', value }),
            ready: self?.ready, canReady, recent: this.recent(), onField: (key: keyof ConnectionFields, value: string) => { this.fields = { ...this.fields, [key]: value }; this.render(); },
            connectionHealth: this.client?.getConnectionHealth(), connectionPlayers: session?.clients.map(({id,name}) => ({id,name})),
            reconnecting: this.client?.connection.isReconnecting,
            managedPlayers: session?.state === 'waiting' && self?.admin && !self.ready ? session?.clients.filter(member => member.id !== self.id) : [],
            onKick: (clientId: number) => this.send('kick', { clientId }), onMakeAdmin: (clientId: number) => this.send('make_admin', { clientId }),
            onHost: () => void this.connect(true), onJoin: () => void this.connect(false), onReady: ready };
        if (this.form) this.form.applyOptions((options: any) => Object.assign(options, props));
        else {
            const [component] = this.jsxRenderer.render(jsx(HtmlView, { width: '100%', height: '100%', innerRef: (ref: any) => this.form = ref, component: Multiplayer, props }));
            this.controller.setMainComponent(component);
        }
        const buttons: any[] = session ? [
            ...(self?.admin ? [{ label: 'Start Game', disabled: session.state !== 'waiting' || !session.clients.filter(member => member.role === 'player' && member.slotIndex !== null).every(member => member.ready && member.mapReady && (!session.content || member.contentReady === session.content.id)) || !session.clients.some(member => member.slotIndex !== null),
                onClick: () => this.send('startgame') }, { label: 'Change Map', disabled: session.state !== 'waiting' || self.ready || this.contentBusy, onClick: () => this.controller.pushScreen(MainMenuScreenType.MapSelection,
                    { lobbyType: LobbyType.MultiplayerHost, gameOpts: this.pregame.getGameOpts(), usedSlots: () => this.pregame.getUsedSlots() }) }] : []),
            { label: self?.ready ? 'Cancel Ready' : 'Ready', disabled: !canReady, onClick: ready },
            { label: 'Leave Server', isBottom: true, onClick: async () => { await this.disconnect(); this.error = undefined; this.render(); } },
        ] : [
            { label: 'Create Game', disabled: this.busy || !props.canHost, onClick: props.onHost },
            { label: 'Join Game', disabled: this.busy, onClick: props.onJoin },
            { label: 'QR LAN', disabled: this.busy, tooltip: 'Open the existing QR connection prototype', onClick: () => this.controller.pushScreen(MainMenuScreenType.LanSetup) },
            { label: 'Back', isBottom: true, onClick: () => this.backToMenu() },
        ];
        this.controller.setSidebarButtons(buttons, true);
        this.controller.setSidebarMpContent({ text: session ? this.strings.get(this.gameModes.getById(session.gameOpts.gameMode).label) + '\n\n' + session.gameOpts.mapTitle : '' });
    }
}
