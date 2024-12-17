# Koishi registry fetch app

For end-user, use our
**Partner registry**
https://kp.itzdrli.cc/

> [!IMPORTANT]  
> If you find an unexpected behaviour different with Koishi's [Official registry](https://registry.koishi.chat/),
> please open an issue.

## Install
Deno is required.
```shell
deno install
```

## Usage
```shell
$ cp .env.example .env
```
```shell
$ deno task start
Listening on http://0.0.0.0:8080/
```

It takes time to synchronize for the first time.

You can configure configurations in main.ts.

Check http://127.0.0.1:8080/api/plugins,
should return currently found plugins.
(It's empty list for a while because no plugins found now, please sit and relax)

Check http://127.0.0.1:8080/index.json
should return a Koishi Registry like JSON of all found plugins.
(The `objects` may be an empty list, because no plugins found now, please sit and relax)

### API Endpoint
#### /api/status
```typescript
let returns: {
  "synchronized": boolean, // If synchronized with npm
  "updateAt": string, // UTC Date String
  features: Record<Feature, boolean> // Field Features
}
```
#### /api/plugins
```typescript
let returns: string[] // a list of package name of koishi plugins
```

## Todo
- [ ] Refactor `NpmWatcher` to provide a more reliable change information.
- [ ] Refactor `KoishiRegistry` cache structure to provide Quick Patch functionality.
- [ ] Support `show_deprecated`, `show_incompatible`, `recover_unpublished` params.
- [ ] Support all fields of official registry
  - [x] verified - defaults to same behaviour with `@koishijs/registry`, 
  - [x] insecure - official insecure detect algorithm and manually marked list is unreachable
                   manually controlled by `koishi/is-insecure`
  - [ ] score    - npm search api is unreliable
  - [ ] rating   - rating algorithm is private (official plugins weights much, so simply marked all official plugin 5 star)
  - [x] portable - detect `koishi.browser` from package meta
  - [ ] downloads - removed due to the hard rate limiting of npm downloads api

## License

The project is All rights reserved.
You are free to deploy the software on your server,
use `Context.prototype.plugin` to plug your own plugin to make modification,
without modify the original codebase.
Any monkeypatch to manipulate original plugin behaviour is not allowed (including modify prototype of classes of this project, or any ES6 builtin object).
The license includes additional restrictions:

ilharp(Individual with GitHub https://github.com/ilharp, refers as "ilharp")
is **FORBIDDEN** to deal with the software in any form (including use, copy, modify, or distribute the software).

Individual or organization related to ilharp **can not** deal with the software without explicit authorization of the project author.

You are **FORBIDDEN** to do anything that would make Deno users unable to use this app (e.g. use Node.js specified feature, or a feature not available in Deno) or use code from this project in a project that does not intended for Deno.

You are **FORBIDDEN** to port this app to Node.js or use code from this project in a project that uses Node.js.

You are FORBIDDEN to use JavaScript in this project (e.g. compile TypeScript source code to JavaScript), you should always use TypeScript in this project.

The above **MUST BE** included in the license of any forks of this project.

