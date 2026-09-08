import React from "react";
import { CompositeDisposable } from "../../../../util/disposable/CompositeDisposable";
const mimeTypeMap = new Map([
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
]);
interface MenuVideoProps {
    src: string | File | undefined;
}
interface MenuVideoState {
}
export class MenuVideo extends React.Component<MenuVideoProps, MenuVideoState> {
    private el: HTMLDivElement | null = null;
    private disposables: CompositeDisposable = new CompositeDisposable();
    private disposed: boolean = false;
    private timeoutId?: number;
    constructor(props: MenuVideoProps) {
        super(props);
    }
    render() {
        const src = this.props.src;
        let url: string;
        let mimeType: string;
        if (typeof src === "string") {
            url = src;
            mimeType = mimeTypeMap.get(src.split("?")[0].split(".").pop() ?? "") ?? "video/webm";
        }
        else if (src) {
            url = URL.createObjectURL(src);
            mimeType = src.type;
            this.disposables.add(() => {
                URL.revokeObjectURL(url);
            });
        }
        else {
            url = "";
            mimeType = "video/webm";
        }
        return React.createElement("div", {
            className: "video-wrapper",
            ref: (ref) => (this.el = ref as HTMLDivElement),
            dangerouslySetInnerHTML: {
                __html: `
          <video style="outline: none;" loop playsinline muted autoplay>
              <source src="${url}" type="${mimeType}" />
          </video>
        `,
            },
        });
    }
    componentDidMount() {
        const src = this.props.src;
        const video = this.el?.querySelector("video");
        // The markup no longer contains a logo <div>; treating it as required
        // made this whole method return early, so no listener below ever ran.
        const logo = this.el?.querySelector<HTMLElement>(".logo");
        if (!src || !video) {
            console.log('[MenuVideo] No video source provided or elements not found');
            return;
        }
        // The `autoplay` attribute is not enough on Chromium: the element is
        // parsed from innerHTML into a container that starts display:none, and
        // it stayed paused at t=0 in the Electron/Linux shell and in a desktop
        // browser alike (WebKit happened to start it). Ask for playback
        // explicitly once data is available; the video is muted, so autoplay
        // policy never blocks this, and a rejected promise is harmless.
        const tryPlay = () => {
            if (video.paused) {
                video.play()?.catch(() => { });
            }
        };
        video.addEventListener("loadeddata", tryPlay);
        video.addEventListener("canplay", tryPlay, { once: true });
        tryPlay();
        if (src instanceof File && window.MediaSource) {
            const errorHandler = async () => {
                console.log('[MenuVideo] Video source error, trying MediaSource fallback');
                this.applyMediaSourceFallback(video, await src.arrayBuffer());
            };
            const source = video.querySelector("source");
            if (source) {
                source.addEventListener("error", errorHandler, { once: true });
                video.addEventListener("loadeddata", () => {
                    source.removeEventListener("error", errorHandler);
                    console.log('[MenuVideo] Video loaded successfully');
                });
            }
        }
        video.addEventListener("loadeddata", () => {
            if (logo) {
                logo.style.opacity = "";
            }
            console.log('[MenuVideo] Video data loaded');
        });
        video.addEventListener("error", (e) => {
            console.error('[MenuVideo] Video error:', e);
        });
    }
    private async applyMediaSourceFallback(video: HTMLVideoElement, buffer: ArrayBuffer): Promise<void> {
        if (!this.disposed) {
            const mediaSource = new MediaSource();
            mediaSource.addEventListener("sourceopen", () => {
                try {
                    const sourceBuffer = mediaSource.addSourceBuffer('video/webm; codecs="vp8"');
                    sourceBuffer.mode = "sequence";
                    sourceBuffer.appendBuffer(buffer);
                    this.timeoutId = setTimeout(() => this.processNextSegment(sourceBuffer, video, buffer), 1000);
                    this.disposables.add(() => {
                        if (this.timeoutId) {
                            clearTimeout(this.timeoutId);
                        }
                    });
                }
                catch (error) {
                    if ((error as Error).name !== "NotSupportedError") {
                        console.error(error);
                    }
                    return;
                }
            });
            const objectUrl = (video.src = URL.createObjectURL(mediaSource));
            this.disposables.add(() => {
                URL.revokeObjectURL(objectUrl);
            });
        }
    }
    private processNextSegment(sourceBuffer: SourceBuffer, video: HTMLVideoElement, buffer: ArrayBuffer): void {
        try {
            if (this.disposed || !sourceBuffer || sourceBuffer.updating) {
                return;
            }
            if (!sourceBuffer.buffered) {
                console.warn('[MenuVideo] SourceBuffer has been removed from MediaSource');
                return;
            }
            if (sourceBuffer.buffered.length > 0) {
                if (sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) - video.currentTime < 10) {
                    sourceBuffer.appendBuffer(buffer);
                }
                if (video.paused) {
                    video.play()?.catch((error) => console.error(error));
                }
            }
        }
        catch (error) {
            console.error('[MenuVideo] Error in processNextSegment:', error);
            return;
        }
        if (!this.disposed) {
            this.timeoutId = setTimeout(() => this.processNextSegment(sourceBuffer, video, buffer), 1000);
        }
    }
    componentWillUnmount() {
        this.disposables.dispose();
        this.disposed = true;
    }
}
