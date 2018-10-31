import * as Logger from "bunyan";

// Add the log attribute to the Request type as bunyanRequest does.
declare global {
    namespace Express {
        interface Request {
            log: Logger
        }
    }
}  
