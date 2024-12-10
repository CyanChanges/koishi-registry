import { Buffer } from "node:buffer";
import avro from 'npm:avsc'

const undefType = avro.types.LongType.__with({
    // deno-lint-ignore no-explicit-any
    fromBuffer: (_: any) => null,
    toBuffer: () => {
        return Buffer.alloc(1);
    },
    fromJSON: ()=>null,
    toJSON: ()=>null,
    // deno-lint-ignore no-explicit-any
    isValid: (undef: any) => typeof undef == 'undefined',
    // deno-lint-ignore no-explicit-any
    compare: (_1: any, _2: any) => 0
});

export const PackageSchema = {
    type: 'record',
    name: 'Package',
    fields: [
        {
            name: 'name',
            type: 'string'
        },
        {
            name: 'keywords',
            type: {
                type: 'array',
                items: 'string'
            }
        },
        {
            name: 'description',
            type: 'string'
        },
        {
            name: 'publisher',
            type: 'user'
        },
        {
            name: 'maintainers',
            type: {
                type: 'array',
                items: 'user'
            }
        },
        {
            name: 'license',
            type: 'string'
        },
        {
            name: 'date',
            type: 'string'
        },
        {
            name: 'links',
            type: {
                type: 'map',
                values: ['string', 'undefined', 'null']
            }
        },
        {
            name: 'contributors',
            type: {
                type: 'array',
                items: 'user'
            }
        },
    ]
} satisfies avro.Schema

export const DescriptionSchema = {
    type: 'map',
    values: 'string'
} satisfies avro.Schema

export const ServiceSchema = {
    type: 'record',
    name: 'Service',
    fields: [
        {
            name: 'required',
            type: { type: 'array', items: 'string' }
        },
        {
            name: 'optional',
            type: { type: 'array', items: 'string' }
        },
        {
            name: 'implements',
            type: { type: 'array', items: 'string' }
        },
    ]
} satisfies avro.Schema

export const ManifestSchema = {
    type: 'record',
    name: 'Manifest',
    fields: [
        {
            name: 'public',
            type: {
                type: 'array',
                items: 'string'
            }
        },
        {
            name: 'description',
            type: ['string', DescriptionSchema, 'undefined']
        },
        {
            name: 'locales',
            type: { type: 'array', items: 'string' }
        },
        {
            name: 'service',
            type: ServiceSchema
        }
    ]
} satisfies avro.Schema

export const UserSchema = avro.Type.forSchema({
    type: 'record',
    name: 'User',
    fields: [
        {
            name: 'name',
            type: ['string', 'null', 'undefined']
        }
    ]
}, {
    registry: {
        undefined: undefType
    }
})

export const ObjectSchema = avro.Type.forSchema({
    type: 'record',
    name: 'Object',
    fields: [
        {
            name: 'downloads',
            type: {
                type: 'record',
                name: 'Downloads',
                fields: [
                    {
                        name: 'lastMonth',
                        type: 'int'
                    }
                ]
            }
        },
        {
            name: 'dependents',
            type: 'int'
        },
        {
            name: 'updated',
            type: 'string'
        },
        {
            name: 'package',
            type: PackageSchema
        },
        {
            name: 'score',
            type: [{
                type: 'record',
                name: 'Score',
                fields: [
                    {
                        name: 'final',
                        type: 'float'
                    }
                ]
            }, 'undefined']
        },
        {
            name: 'flags',
            type: {
                type: 'record',
                name: 'Flags',
                fields: [
                    {
                        name: 'insecure',
                        type: 'int'
                    }
                ]
            }
        },
        {
            name: 'shortname',
            type: 'string'
        },
        {
            name: 'verified',
            type: 'boolean'
        },
        {
            name: 'manifest',
            type: ManifestSchema
        },
        {
            name: 'insecure',
            type: 'boolean'
        },
        {
            name: 'category',
            type: 'string'
        },
        {
            name: 'createdAt',
            type: 'string'
        },
        {
            name: 'updatedAt',
            type: 'string'
        },
        {
            name: 'rating',
            type: ['int', 'undefined', 'null']
        },
        {
            name: 'portable',
            type: 'boolean'
        },
        {
            name: 'installSize',
            type: ['int', 'undefined', 'null']
        },
        {
            name: 'publishSize',
            type: 'int'
        },
    ]
}, {
    registry: {
        user: UserSchema,
        undefined: undefType
    }
})

export const ObjectList = avro.Type.forSchema({
    type: 'array',
    items: 'object'
}, {
    registry: {
        object: ObjectSchema
    }
})

