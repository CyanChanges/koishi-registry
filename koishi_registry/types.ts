import { Registry as RegistryResult, User as RegistryUser, type IconSvg } from '@koishijs/registry'
import { RemotePackage } from "@koishijs/registry";
import type { Dict } from "cosmokit";

export namespace NpmRegistry {
    export interface User {
        name?: string
        email: string
        url?: string
        username?: string
    }

    export interface VersionMeta extends RemotePackage {
        _npmUser: User // I don't know what is this
    }

    export interface OkResult extends RegistryResult {
        _id: string,
        _rev: string,
        'dist-tags': Dict<string, string>,
        maintainers: (string | User)[],
        keywords: string[],
        versions: Dict<VersionMeta>,
        bugs?: { url?: string },
        homepage?: string,
        repository?: { type?: string, url?: string },
        koishi: KoishiMarket.Manifest,
        revs?: string[],
    }

    export type Result = OkResult

    export interface DownloadAPIResult {
        downloads: number,
        start: string,
        end: string,
        package: string
    }

    export interface ErrorInfo {
        error: string
    }
}

export namespace KoishiMarket {
    export interface Result {
        time: string,
        version?: number,
        objects: Object[]
    }

    export interface Object {
        downloads: { lastMonth: number }
        dependents: number
        updated: string
        package: Package
        // score: Score
        score?: Score
        flags: Flags
        shortname: string
        verified: boolean
        manifest: Manifest
        insecure: boolean
        category: string
        createdAt: string
        updatedAt: string
        // rating: number
        rating?: number
        portable: boolean
        // installSize: number
        installSize?: number
        publishSize: number
    }

    export interface User extends RegistryUser {}

    export interface Package {
        name: string
        keywords: string[]
        version: string
        description: string
        publisher: User
        maintainers: User[]
        license: string
        date: string
        links: Links
        contributors: User[]
    }

    export interface Links {
        homepage?: string
        repository?: string
        npm: string
        bugs?: string
    }

    export interface Score {
        final: number
    }

    export interface Flags {
        insecure: number
    }

    export interface Manifest {
        icon?: IconSvg
        hidden?: boolean
        preview?: boolean
        insecure?: boolean
        browser?: boolean
        category?: string
        public?: string[]
        exports?: Dict<string>
        description: string | Dict<string>
        service: Service
        locales: string[]
    }

    export interface Description {
        [lang: string]: string
    }

    export interface Service {
        required: string[]
        optional: string[]
        implements: string[]
    }
}
