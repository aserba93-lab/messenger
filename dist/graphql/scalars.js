import { GraphQLScalarType, Kind } from "graphql";
export const DateTimeScalar = new GraphQLScalarType({
    name: "DateTime",
    description: "ISO-8601 DateTime",
    serialize(value) {
        if (value instanceof Date)
            return value.toISOString();
        return new Date(value).toISOString();
    },
    parseValue(value) {
        return new Date(value);
    },
    parseLiteral(ast) {
        if (ast.kind === Kind.STRING)
            return new Date(ast.value);
        return null;
    },
});
export const JSONScalar = new GraphQLScalarType({
    name: "JSON",
    description: "Arbitrary JSON",
    serialize(value) {
        return value;
    },
    parseValue(value) {
        return value;
    },
    parseLiteral(ast) {
        switch (ast.kind) {
            case Kind.STRING:
                return ast.value;
            case Kind.INT:
            case Kind.FLOAT:
                return Number(ast.value);
            case Kind.BOOLEAN:
                return ast.value;
            case Kind.OBJECT: {
                const value = {};
                for (const field of ast.fields) {
                    value[field.name.value] = JSONScalar.parseLiteral(field.value);
                }
                return value;
            }
            case Kind.LIST:
                return ast.values.map((n) => JSONScalar.parseLiteral(n));
            default:
                return null;
        }
    },
});
