import { CsfFile } from './CsfFile';
import { sprintf } from 'sprintf-js';
export class Strings {
    private data: {
        [key: string]: string;
    } = {};
    constructor(source?: CsfFile | {
        [key: string]: string;
    }) {
        if (source) {
            if (source instanceof CsfFile) {
                this.fromCsf(source);
            }
            else if (typeof source === 'object') {
                this.fromJson(source as {
                    [key: string]: string;
                });
            }
        }
    }
    public fromCsf(csfFile: CsfFile): void {
        this.fromJson(csfFile.data);
    }
    public fromJson(jsonData: {
        [key: string]: string;
    }): void {
        for (const key of Object.keys(jsonData)) {
            this.setValue(key, this.sanitizeValue(jsonData[key]));
        }
    }
    private sanitizeValue(value: string): string {
        return value.replace(/%hs/g, "%s");
    }
    public setValue(key: string, value: string): void {
        this.data[key.toLowerCase()] = value;
    }
    public has(key: string): boolean {
        return !!this.data[key.toLowerCase()];
    }
    public get(key: string, ...args: any[]): string {
        const name = String(key);
        let value = this.data[name.toLowerCase()];
        if (value) {
            if (typeof value !== 'string') {
                console.warn(`Invalid string value for name "${key}"`);
                return key as unknown as string;
            }
            if (!args.length)
                return value;
            try {
                return sprintf(value, ...args);
            }
            catch (e) {
                // A CSF template whose placeholders don't match the args (e.g. %d
                // given a preformatted "12.3 MB" string) must not crash the caller.
                console.warn(`[Strings] Format mismatch for "${name}" ("${value}")`, e);
                return `${value} ${args.join(" ")}`;
            }
        }
        if ((/^NOSTR:/i).test(name)) {
            return name.replace(/^NOSTR:/i, "");
        }
        console.warn(`[Strings] String with name "${name}" not found"`);
        return name as unknown as string;
    }
    public getKeys(): string[] {
        return Object.keys(this.data);
    }
    public beginOverlay(values: Record<string, string>): () => void {
        const previous = this.data;
        this.data = { ...previous };
        this.fromJson(values);
        let restored = false;
        return () => {
            if (restored) return;
            restored = true;
            this.data = previous;
        };
    }
}
