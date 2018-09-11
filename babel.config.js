const presets = [
    ["@babel/env", {
        targets: {
            node: true
        },
        useBuiltIns: "usage"
    }],
    "@babel/preset-typescript"
];

module.exports = { presets };
