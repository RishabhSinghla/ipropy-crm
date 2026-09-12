import type { CapacitorConfig } from '@capacitor/cli';

/*
 * The native app is the same React bundle this package already builds, wrapped
 * in a real Android/iOS project and installed on the device.
 *
 * It lives here, rather than in a package of its own, so there is exactly one
 * list of Capacitor plugins — the dependencies below `@ipropy/web`. `cap sync`
 * reads that list to copy each plugin's native code into the platforms, and
 * the bundler resolves the same list for the `await import()` calls in
 * `src/lib/native*.ts`. Two lists would drift, and the failure would be a
 * plugin that type-checks, builds, ships, and then does nothing on the phone.
 *
 * The generated Android and iOS projects are kept out of this package (see
 * `android.path`) because everything here is copied into the Docker image
 * Render builds, and a 200 MB Gradle project has no business in a web server.
 */
const config: CapacitorConfig = {
  appId: 'com.ipropy.crm',
  appName: 'iPropy',
  webDir: 'dist',
  android: { path: '../app/android' },
  ios: { path: '../app/ios' },
  server: {
    /*
      `https` rather than Capacitor's older `http` default. The webview treats
      the bundle as a secure origin either way, but a plain-http origin is
      refused by a growing list of the browser APIs this app actually uses —
      geolocation and the camera among them — and the failure is a permission
      prompt that never appears.
    */
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      // Hidden by hand after React paints — see `hideSplash` in nativeBridges.
      // An auto-hide races the first render and shows a white flash.
      launchAutoHide: false,
      backgroundColor: '#6366f1',
      androidScaleType: 'CENTER_CROP',
    },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
