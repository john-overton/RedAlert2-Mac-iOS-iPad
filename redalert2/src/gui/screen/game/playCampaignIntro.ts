/** Await the briefing movie before starting simulation; the player may skip it. */
export function playCampaignIntro(): Promise<void> {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:black;z-index:3000;display:flex;align-items:center;justify-content:center';
        const video = document.createElement('video');
        video.src = new URL('campaign/ra2/allied-01/intro.mp4',document.baseURI).href;
        video.controls = false; video.autoplay = true; video.playsInline = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain';
        const skip = document.createElement('button');
        skip.textContent = 'Skip Intro';
        skip.style.cssText = 'position:absolute;right:24px;bottom:24px;padding:12px 24px;font-size:18px';
        const finish = () => { video.pause(); overlay.remove(); resolve(); };
        skip.onclick = video.onended = video.onerror = finish;
        overlay.append(video,skip); document.body.append(overlay);
        video.play().catch(() => { /* Skip Intro remains available if autoplay is blocked. */ });
    });
}
