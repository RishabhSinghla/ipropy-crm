# Background music for video uploads

Drop a single royalty-free/CC0 instrumental track here as `background.mp3`
and the video processing pipeline (`core/media/video.ts`) will automatically
mix it under every processed video at low volume (~16%), looped/trimmed to
match the video's length. **No track is bundled by default** — this step is
silently skipped until one exists here, same as every other optional stage
in that pipeline.

Whatever you add must be properly licensed for commercial use (CC0, or a
license that explicitly permits this). Note its source and license here
when you do, so it's traceable:

```
Track:    (none yet)
Source:   —
License:  —
```
