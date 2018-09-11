const presets = [
    "@babel/preset-typescript",
    ["@babel/env", {
        targets: {
            node: true
        },
        useBuiltIns: "usage"
    }]
];