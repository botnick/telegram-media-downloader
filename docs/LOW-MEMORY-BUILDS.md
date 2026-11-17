# Running and building on small hosts

Most installs pull the prebuilt multi-arch image (`ghcr.io/botnick/telegram-media-downloader`) and never compile anything; that is also the right choice on a Raspberry Pi. This page covers two separate things: keeping a running server light, and building the image yourself on a host with little memory.

## Running on a 1 GiB host (Raspberry Pi 4 and similar)

1. In **Settings → Advanced**, press **Use low-resource profile**. It lowers download and backfill concurrency and turns off automatic seekbar, NSFW and AI work. Queued jobs and files are kept.
2. In `.env`, uncomment the small-host block from `.env.example`:

   ```sh
   TGDL_MEM_LIMIT=512m          # container memory ceiling (docker-compose.yml)
   GOMEMLIMIT=320MiB            # soft Go heap target, below the ceiling
   TGDL_DOWNLOAD_THREADS=1      # parts of one large file fetched at once
   FASTSTART_CONCURRENCY=1      # MP4 faststart workers
   ```

3. Keep the data directory on a USB disk for large libraries.

`GOMEMLIMIT` is only a target for the Go heap; `TGDL_MEM_LIMIT` is the hard container limit. Leave headroom between them.

## Building the image on a small host

Compiling `github.com/gotd/td/tg` (the generated Telegram API package) needs a lot of memory, and a build with default parallelism can be killed (`compile: signal: killed`, `cannot allocate memory`). The Dockerfile accepts three optional build arguments; empty means Go's defaults, which is what the published images use.

```sh
docker build \
  --build-arg GO_BUILD_JOBS=1 \
  --build-arg GO_BUILD_MAXPROCS=2 \
  --build-arg GO_BUILD_MEMLIMIT=1536MiB \
  -t telegram-media-downloader:local .
```

- `GO_BUILD_JOBS` → `go build -p`: how many packages compile at once.
- `GO_BUILD_MAXPROCS` → `GOMAXPROCS` for the compiler.
- `GO_BUILD_MEMLIMIT` → `GOMEMLIMIT` for the compiler (a soft limit; the linker and BuildKit still need headroom).

Go modules and the build cache live in BuildKit cache mounts, so a second build after a source change reuses them. To run your local image, set `image: telegram-media-downloader:local` in `docker-compose.yml` and remove `pull_policy: always`.

Build and Pi guidance contributed by Zacky Achmad ([@zckyachmd](https://github.com/zckyachmd)).
