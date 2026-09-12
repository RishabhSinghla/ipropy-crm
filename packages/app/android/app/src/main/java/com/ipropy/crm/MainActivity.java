package com.ipropy.crm;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * Registered before super.onCreate, which is where the bridge is built
         * and the plugin list is frozen. Registering afterwards compiles, runs,
         * and leaves every CallSync call rejecting with "plugin not
         * implemented" — which reads as a broken plugin rather than as a line
         * in the wrong order.
         */
        registerPlugin(CallSyncPlugin.class);
        super.onCreate(savedInstanceState);

        allowPlainHttpInDebugBuilds();
    }

    /**
     * Let a debug build talk to an API running on a developer's laptop.
     *
     * The app serves its own HTML from `https://localhost`, so the WebView
     * treats every page as secure and refuses plain-HTTP subresources as mixed
     * content. Against `http://10.0.2.2:4000` that blocks every single request
     * — and the way it fails is the problem: there is no network error, no
     * status code and no timeout, just a rejected promise. On screen it reads
     * as "Could not sign in", which sends you looking at passwords and CORS
     * rather than at the scheme.
     *
     * The permissive mode is also not enough on its own. `networkSecurityConfig`
     * in `src/debug` has to allow cleartext to that host as well; either one
     * missing blocks the request, and they fail identically.
     *
     * Guarded by BuildConfig.DEBUG, so a release build keeps the platform
     * default and refuses plain HTTP outright. Production is
     * https://crm.ipropy.com, where none of this applies.
     */
    private void allowPlainHttpInDebugBuilds() {
        if (!BuildConfig.DEBUG) return;
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
}
