"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.HttpException = void 0;
const client_oauth2_1 = __importDefault(require("client-oauth2"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const connect_redis_1 = __importDefault(require("connect-redis"));
const helmet_1 = __importDefault(require("helmet"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const morgan_1 = __importDefault(require("morgan"));
const path_1 = __importDefault(require("path"));
const querystring_1 = __importDefault(require("querystring"));
const session_file_store_1 = __importDefault(require("session-file-store"));
const url_1 = require("url");
const winston_1 = require("../configs/winston");
const envs_1 = require("../configs/envs");
const constants_1 = require("../constants");
const utils_1 = require("./utils");
const settings_1 = require("../configs/settings");
const redisClient_1 = require("./helpers/redisClient");
const dollar_imports_1 = require("./dollar-imports");
const opensrpAuth = new client_oauth2_1.default({
    accessTokenUri: envs_1.EXPRESS_OPENSRP_ACCESS_TOKEN_URL,
    authorizationUri: envs_1.EXPRESS_OPENSRP_AUTHORIZATION_URL,
    clientId: envs_1.EXPRESS_OPENSRP_CLIENT_ID,
    clientSecret: envs_1.EXPRESS_OPENSRP_CLIENT_SECRET,
    redirectUri: envs_1.EXPRESS_OPENSRP_CALLBACK_URL,
    scopes: envs_1.EXPRESS_OPENSRP_SCOPES,
    state: envs_1.EXPRESS_OPENSRP_OAUTH_STATE,
});
const loginURL = envs_1.EXPRESS_SESSION_LOGIN_URL;
const sessionName = envs_1.EXPRESS_SESSION_NAME;
const app = (0, express_1.default)();
app.use((0, compression_1.default)()); // Compress all routes
// helps mitigate cross-site scripting attacks and other known vulnerabilities
const cspConfig = (0, settings_1.readCspOptionsConfig)();
app.use((0, helmet_1.default)({
    // override default contentSecurityPolicy directive like script-src to include cloudflare cdn and github static content
    // might consider turning this off to allow individual front-ends set Content-Security-Policy on meta tags themselves if list grows long
    // <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'  https://cdnjs.cloudflare.com;" >
    contentSecurityPolicy: cspConfig,
    crossOriginEmbedderPolicy: false,
}));
app.use((0, morgan_1.default)('combined', { stream: winston_1.winstonStream })); // send request logs to winston streamer
let sessionStore;
const redisClient = (0, redisClient_1.getRedisClient)();
if (redisClient) {
    const RedisStore = (0, connect_redis_1.default)(express_session_1.default);
    sessionStore = new RedisStore({ client: redisClient });
}
// else default to file store
else {
    winston_1.winstonLogger.error('Redis Connection Error: Redis configs not provided using file session store');
    const FileStore = (0, session_file_store_1.default)(express_session_1.default);
    sessionStore = new FileStore({
        path: envs_1.EXPRESS_SESSION_FILESTORE_PATH || './sessions',
        logFn: (message) => winston_1.winstonLogger.info(message),
    });
}
let nextPath;
const sess = {
    cookie: {
        httpOnly: true,
        path: envs_1.EXPRESS_SESSION_PATH || '/',
        secure: false,
    },
    name: sessionName,
    resave: true,
    saveUninitialized: true,
    secret: envs_1.EXPRESS_SESSION_SECRET || 'hunter2',
    store: sessionStore,
};
if (app.get('env') === 'production') {
    app.set('trust proxy', 1); // trust first proxy
    sess.cookie.secure = true; // serve secure cookies
}
app.use((0, cookie_parser_1.default)());
app.use((0, express_session_1.default)(sess));
// apply other headers to reponse
app.use((_, res, next) => {
    const customHeaders = Object.entries(envs_1.EXPRESS_RESPONSE_HEADERS);
    if (customHeaders.length > 0) {
        customHeaders.forEach(([key, value]) => {
            if (typeof value === 'string' && value !== '') {
                res.header(key, value);
            }
        });
    }
    next();
});
class HttpException extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.message = message;
    }
}
exports.HttpException = HttpException;
const handleError = (err, res) => {
    const { message } = err;
    if (message.includes('resource owner or authorization server denied the request')) {
        return res.redirect(envs_1.EXPRESS_FRONTEND_LOGIN_URL);
    }
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
        message,
        status: 'error',
        statusCode,
    });
};
const BUILD_PATH = envs_1.EXPRESS_REACT_BUILD_PATH;
const filePath = path_1.default.resolve(BUILD_PATH, 'index.html');
const fs_1 = require('fs');
// Inject a sidebar link to the BKM Health Portal (port 9902) using a
// MutationObserver so it survives React re-renders.
const BKM_NAV_SCRIPT = `<script>
(function(){
  var HREF='http://localhost:9902/#/services';
  var LABEL='BKM Health Portal';
  var ICON='M19 3H5c-1.1 0 -2 .9 -2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z';
  function inject(){
    var nav=document.querySelector('nav ul, .ant-menu, [class*="sidebar"] ul, [class*="Sidebar"] ul, [class*="nav"] ul');
    if(!nav||document.getElementById('bkm-nav-link'))return;
    var li=document.createElement('li');
    li.id='bkm-nav-link';
    li.style.cssText='list-style:none;padding:0';
    li.innerHTML='<a href="'+HREF+'" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;padding:8px 16px;color:inherit;text-decoration:none;font-size:14px;white-space:nowrap" title="'+LABEL+'">'
      +'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="'+ICON+'"/></svg>'
      +LABEL+'</a>';
    nav.appendChild(li);
  }
  var obs=new MutationObserver(inject);
  obs.observe(document.body,{childList:true,subtree:true});
  inject();
})();
</script>`;
const _indexHtmlCache = { html: null };
const renderer = (_, res) => {
    if (!_indexHtmlCache.html) {
        try {
            const raw = fs_1.readFileSync(filePath, 'utf8');
            _indexHtmlCache.html = raw.replace('</head>', BKM_NAV_SCRIPT + '</head>');
        } catch (_) {
            return res.sendFile(filePath);
        }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_indexHtmlCache.html);
};
const oauthLogin = (_, res) => {
    const provider = opensrpAuth;
    const uri = provider.code.getUri();
    res.redirect(uri);
};
const processUserInfo = (req, res, processedUserDetails, isRefresh) => {
    var _a, _b, _c, _d, _e;
    // get user details from session. will be needed when refreshing token
    let userInfo = (_c = processedUserDetails !== null && processedUserDetails !== void 0 ? processedUserDetails : (_b = (_a = req.session.preloadedState) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.extraData) !== null && _c !== void 0 ? _c : {};
    const date = new Date(Date.now());
    const sessionExpiryTime = (_d = req.session.preloadedState) === null || _d === void 0 ? void 0 : _d.session_expires_at;
    const sessionExpiresAt = isRefresh
        ? sessionExpiryTime
        : new Date(date.setSeconds(date.getSeconds() + envs_1.EXPRESS_MAXIMUM_SESSION_LIFE_TIME)).toISOString();
    userInfo = Object.assign(Object.assign({}, userInfo), { extraData: Object.assign({}, userInfo.extraData) });
    const sessionState = userInfo;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (sessionState) {
        const gatekeeperState = {
            success: true,
            result: sessionState.extraData,
        };
        const preloadedState = {
            gatekeeper: gatekeeperState,
            session: sessionState,
            session_expires_at: sessionExpiresAt,
        };
        req.session.preloadedState = preloadedState;
        const expireAfterMs = ((_e = sessionState.extraData) === null || _e === void 0 ? void 0 : _e.oAuth2Data.refresh_expires_in) * 1000;
        req.session.cookie.maxAge = expireAfterMs;
        // when refreshing token we only need the preloaded state
        if (isRefresh) {
            req.session.save(() => undefined);
            return preloadedState;
        }
        // Save session BEFORE redirecting: session-file-store writes async, so
        // redirecting immediately races with the browser's follow-up /oauth/state
        // request — session not on disk yet → "Not authorized" → login flash loop.
        req.session.save(() => {
            if (nextPath) {
                const localNextPath = nextPath;
                nextPath = undefined;
                res.redirect(localNextPath);
            }
            else {
                res.redirect(envs_1.EXPRESS_FRONTEND_OPENSRP_CALLBACK_URL);
            }
        });
    }
};
const refreshToken = (req, res, next) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    // check if token refreshing is allowed
    if (!envs_1.EXPRESS_ALLOW_TOKEN_RENEWAL) {
        winston_1.winstonLogger.info(constants_1.SESSION_IS_EXPIRED);
        return res.status(500).send({ message: constants_1.SESSION_IS_EXPIRED });
    }
    const accessToken = (_d = (_c = (_b = (_a = req.session.preloadedState) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.extraData) === null || _c === void 0 ? void 0 : _c.oAuth2Data) === null || _d === void 0 ? void 0 : _d.access_token;
    // eslint-disable-next-line @typescript-eslint/no-shadow
    const refreshToken = (_h = (_g = (_f = (_e = req.session.preloadedState) === null || _e === void 0 ? void 0 : _e.session) === null || _f === void 0 ? void 0 : _f.extraData) === null || _g === void 0 ? void 0 : _g.oAuth2Data) === null || _h === void 0 ? void 0 : _h.refresh_token;
    const sessionExpiryTime = (_j = req.session.preloadedState) === null || _j === void 0 ? void 0 : _j.session_expires_at;
    if (!accessToken || !refreshToken || !sessionExpiryTime) {
        winston_1.winstonLogger.info(constants_1.TOKEN_NOT_FOUND);
        return res.status(500).send({ message: constants_1.TOKEN_NOT_FOUND });
    }
    // check if session set maxmum life is exceeded
    if (new Date(Date.now()) >= new Date(sessionExpiryTime)) {
        winston_1.winstonLogger.info(constants_1.SESSION_IS_EXPIRED);
        return res.status(500).send({ message: constants_1.SESSION_IS_EXPIRED });
    }
    const provider = opensrpAuth;
    // re-create an access token instance
    const token = provider.createToken(accessToken, refreshToken);
    return token
        .refresh()
        .then((oauthRes) => {
        const opensrpUserInfo = (0, utils_1.parseOauthClientData)(oauthRes);
        const preloadedState = processUserInfo(req, res, opensrpUserInfo, true);
        return res.json(preloadedState);
    })
        .catch((error) => {
        next(error); // pass error to express
        return res.status(500).send({ message: error.message || constants_1.TOKEN_REFRESH_FAILED });
    });
};
const oauthCallback = (req, res, next) => {
    const provider = opensrpAuth;
    provider.code
        .getToken(req.originalUrl)
        .then((user) => {
        try {
            const opensrpUserInfo = (0, utils_1.parseOauthClientData)(user);
            processUserInfo(req, res, opensrpUserInfo);
        }
        catch (__) {
            res.redirect('/logout?serverLogout=true');
        }
    })
        .catch((e) => {
        next(e); // pass error to express
    });
};
const oauthState = (req, res) => {
    // check if logged in
    if (!req.session.preloadedState) {
        winston_1.winstonLogger.info('Not authorized');
        return res.json({ error: 'Not authorized' });
    }
    // only return this when user has valid session
    return res.json(req.session.preloadedState);
};
const loginRedirect = (req, res, _) => {
    // check if logged in and redirect
    const parsedUrl = (0, url_1.parse)(req.originalUrl);
    const searchParam = parsedUrl.search;
    if (searchParam) {
        let searchString = searchParam;
        // remove the leading '?'
        if (searchParam.charAt(0) === '?') {
            searchString = searchParam.replace('?', '');
        }
        const searchParams = querystring_1.default.parse(searchString);
        nextPath = searchParams.next;
    }
    const localNextPath = nextPath || '/';
    return req.session.preloadedState ? res.redirect(localNextPath) : res.redirect(envs_1.EXPRESS_FRONTEND_LOGIN_URL);
};
const logout = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (req.query.serverLogout) {
        const accessToken = (_d = (_c = (_b = (_a = req.session.preloadedState) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.extraData) === null || _c === void 0 ? void 0 : _c.oAuth2Data) === null || _d === void 0 ? void 0 : _d.access_token;
        const idTokenHint = (_h = (_g = (_f = (_e = req.session.preloadedState) === null || _e === void 0 ? void 0 : _e.session) === null || _f === void 0 ? void 0 : _f.extraData) === null || _g === void 0 ? void 0 : _g.oAuth2Data) === null || _h === void 0 ? void 0 : _h.id_token;
        const payload = {
            headers: {
                accept: 'application/json',
                contentType: 'application/json;charset=UTF-8',
                authorization: `Bearer ${accessToken}`,
            },
            method: 'GET',
        };
        if (accessToken && envs_1.EXPRESS_OPENSRP_LOGOUT_URL) {
            yield (0, node_fetch_1.default)(envs_1.EXPRESS_OPENSRP_LOGOUT_URL, payload);
        }
        let logoutParams = {};
        if (idTokenHint) {
            logoutParams = {
                post_logout_redirect_url: envs_1.EXPRESS_SERVER_LOGOUT_URL,
                id_token_hint: idTokenHint,
            };
        }
        const searchQuery = new URLSearchParams(logoutParams).toString();
        const keycloakLogoutFullPath = `${envs_1.EXPRESS_KEYCLOAK_LOGOUT_URL}?${searchQuery}`;
        (0, utils_1.sessionLogout)(req, res);
        res.redirect(keycloakLogoutFullPath);
    }
    else {
        (0, utils_1.sessionLogout)(req, res);
        res.redirect(loginURL);
    }
});
// OAuth views
const router = express_1.default.Router();
router.use('/([$])import', dollar_imports_1.importerRouter);
router.use('/oauth/opensrp', oauthLogin);
router.use('/oauth/callback/OpenSRP', oauthCallback);
router.use('/oauth/state', oauthState);
router.use('/refresh/token', refreshToken);
// handle login
router.use(loginURL, loginRedirect);
// logout
router.use('/logout', logout);
// render React app
router.use('^/$', renderer);
// other static resources should just be served as they are
router.use(express_1.default.static(BUILD_PATH, { maxAge: '30d' }));
// sends other routes to be handled by React Router
router.use('*', renderer);
// tell the app to use the above rules
app.use(router);
const errorHandler = (err, _, res, 
// eslint-disable-next-line @typescript-eslint/naming-convention
__) => {
    winston_1.winstonLogger.error(`${err.statusCode || 500} - ${err.message}-${JSON.stringify(err.stack)}`);
    handleError(err, res);
};
exports.errorHandler = errorHandler;
app.use(exports.errorHandler);
exports.default = app;
//# sourceMappingURL=index.js.map