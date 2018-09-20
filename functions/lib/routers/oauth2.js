"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bunyan = require("bunyan");
const express_1 = require("express");
const log = bunyan.createLogger({ name: "oauth2" });
const router = express_1.Router();
router.get("auth/:provider", (req, res) => {
});
exports.default = router;
//# sourceMappingURL=oauth2.js.map