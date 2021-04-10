import Node from "./Node";
import request from "node-superfetch";
import { LavalinkTrack, LavalinkTrackResponse, SpotifyAlbum, SpotifyPlaylist, SpotifyTrack } from "../typings";
import Util from "../Util";

export default class Resolver {
    public client = this.node.client;
    public cache = new Map<string, LavalinkTrack>();

    public constructor(public node: Node) {}

    public get token(): string {
        return this.client.token!;
    }

    public get playlistPageLimit(): number {
        return this.client.options.playlistPageLimit === 0
            ? Infinity
            : this.client.options.playlistPageLimit!;
    }

    public async getAlbum(id: string): Promise<LavalinkTrackResponse | null> {
        const album = await Util.tryPromise(async () => {
            return (await request
                .get(`${this.client.baseURL}/albums/${id}`)
                .set("Authorization", this.token)).body as SpotifyAlbum;
        });

        return album ? {
            type: "PLAYLIST",
            playlistName: album?.name,
            tracks: (await Promise.all(album.tracks.items.map(x => this.resolve(x)))).filter(Boolean) as LavalinkTrack[]
        } : null;
    }

    public async getPlaylist(id: string): Promise<LavalinkTrackResponse | null> {
        const playlist = await Util.tryPromise(async () => {
            return (await request
                .get(`${this.client.baseURL}/playlists/${id}`)
                .set("Authorization", this.token)).body as SpotifyPlaylist;
        });

        const playlistTracks = playlist ? await this.getPlaylistTracks(playlist) : [];

        return playlist ? {
            type: "PLAYLIST",
            playlistName: playlist?.name,
            tracks: (await Promise.all(playlistTracks.map(x => this.resolve(x.track)))).filter(Boolean) as LavalinkTrack[]
        } : null;
    }

    public async getTrack(id: string): Promise<LavalinkTrackResponse | null> {
        const track = await Util.tryPromise(async () => {
            return (await request
                .get(`${this.client.baseURL}/tracks/${id}`)
                .set("Authorization", this.token)).body as SpotifyTrack;
        });

        const lavaTrack = track && await this.resolve(track);

        return lavaTrack ? {
            type: "PLAYLIST",
            playlistName: null,
            tracks: [lavaTrack]
        } : null;
    }

    private async getPlaylistTracks(playlist: {
        tracks: {
            items: Array<{ track: SpotifyTrack }>;
            next: string | null;
        };
    }, currPage = 1): Promise<Array<{ track: SpotifyTrack }>> {
        if (!playlist.tracks.next || currPage >= this.playlistPageLimit) return playlist.tracks.items;
        currPage++;

        const { body }: any = await request
            .get(playlist.tracks.next)
            .set("Authorization", this.token);

        const { items, next }: { items: Array<{ track: SpotifyTrack }>; next: string | null } = body;

        const mergedPlaylistTracks = playlist.tracks.items.concat(items);

        if (next && currPage < this.playlistPageLimit) return this.getPlaylistTracks({
            tracks: {
                items: mergedPlaylistTracks,
                next
            }
        }, currPage);
        else return mergedPlaylistTracks;
    }

    private async resolve(track: SpotifyTrack): Promise<LavalinkTrack | undefined> {
        const cached = this.cache.get(track.id);
        if (cached) return Util.structuredClone(cached);

        try {
            const params = new URLSearchParams({
                identifier: `ytsearch:${track.artists[0].name} - ${track.name} ${this.client.options.audioOnlyResults ? "description:(\"Auto-generated by YouTube.\")" : ""}`
            }).toString();

            // @ts-expect-error 2322
            const { body }: { body: LavalinkTrackResponse } = await request
                .get(`http${this.node.secure ? "s" : ""}://${this.node.host}:${this.node.port}/loadtracks?${params}`)
                .set("Authorization", this.node.auth);

            if (body.tracks.length) {
                const lavaTrack = body.tracks[0];
                if (this.client.options.useSpotifyMetadata) {
                    Object.assign(lavaTrack.info, {
                        title: track.name,
                        author: track.artists.map(artist => artist.name).join(", "),
                        uri: track.external_urls.spotify
                    });
                }
                this.cache.set(track.id, Object.freeze(lavaTrack));
            }

            return Util.structuredClone(body.tracks[0]);
        } catch {
            return undefined;
        }
    }
}
