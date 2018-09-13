import oauth2App from "./oauth2-app";
import { MemoryTokenStorage } from "./token-storage";

const app = oauth2App(new MemoryTokenStorage());
app.listen(8080);
