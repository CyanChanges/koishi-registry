# Koishi registry fetch app

## Install
Deno is required.
```shell
deno install
```

## Run
```shell
$ deno task start
Listening on http://0.0.0.0:8080/
```

It takes time to synchronize for the first time.

You can configure 

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

## License
This project is under the [AGPL 3.0](https://www.gnu.org/licenses/agpl-3.0.en.html#license-text) license with the following additional restrictions:

- You are **FORBIDDEN** to do anything that would make Deno users unable to use this app (e.g. use Node.js specified feature, or a feature not available in Deno)
  or use code from this project in a project that does not intended for Deno.
- You are **FORBIDDEN** to port this app to Node.js or use code from this project in a project that uses Node.js.
- You are **FORBIDDEN** to use JavaScript in this project (e.g. compile TypeScript source code to JavaScript), you should **always** use TypeScript in this project.
- The above **MUST BE** included in the license of any forks of this project.
