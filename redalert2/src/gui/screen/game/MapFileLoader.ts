import { FileNotFoundError } from '@/data/vfs/FileNotFoundError';
import { VirtualFile } from '@/data/vfs/VirtualFile';
export class MapFileLoader {
    constructor(private resourceLoader: any, private vfs?: any) { }
    async load(filename: string, cancellationToken?: any): Promise<VirtualFile> {
        if (filename === 'all01t.map') {
            const response = await fetch(new URL('campaign/ra2/allied-01/all01t.map', document.baseURI));
            if (!response.ok) throw new Error('Mission one is not installed in this build');
            return VirtualFile.fromBytes(new Uint8Array(await response.arrayBuffer()), filename);
        }
        let mapFile: VirtualFile | undefined;
        if (this.vfs) {
            try {
                mapFile = await this.vfs.openFileWithRfs(filename);
            }
            catch (error) {
                if (!(error instanceof FileNotFoundError)) {
                    console.error(error);
                }
            }
        }
        if (!mapFile) {
            const bytes = await this.resourceLoader.loadBinary(filename, cancellationToken);
            mapFile = VirtualFile.fromBytes(bytes, filename);
        }
        return mapFile;
    }
}
