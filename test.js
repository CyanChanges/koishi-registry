const packages = [
    "@koishijs/plugin-help",
    "@koishijs/plugin-echo",
    "@koishijs/registry",
    "koishi-plugin-totp",
    "koishi-plugin-blockly",
    "koishi-plugin-phigros",
    "@koishijs/plugin-notifier",
    "koishi-plugin-color",
    "koishi-plugin-markdown",
    "koishi-plugin-yesimbot"
]

await Promise.all(
    [
        ...Array.from(
        {length: 10000},
        (_, k) => fetch(`https://registry.npmmirror.com/-/v1/search?text=koishi-plugin-&page=${k%200}`).then(r=>{
            if (r.status != 200) console.log('search ', r.status)
            r.json().then(r=>r.objects).then(objects=>{if(!objects) console.log('search!', objects)})
        })
    ),
        ...Array.from(
            {length: 10000},
            (_, k) => fetch(`https://registry.npmmirror.com/${packages[k%packages.length]}`).then(r=>{
                if (r.status != 200) console.log("pack   ", r.status)
                r.json().then(r=>{
                    if (!('name' in r && 'versions' in r && 'repository' in r)) console.log("pack!  ", r)
                })
            })
        )
    ]
)
