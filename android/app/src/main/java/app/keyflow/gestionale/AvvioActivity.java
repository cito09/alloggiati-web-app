package app.keyflow.gestionale;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * Apre KeyFlow a schermo intero. Usa Chrome anche se il browser predefinito del telefono è un
 * altro: con browser che non sanno fare le "app web fidate" comparirebbe la barra con la X.
 * Senza Chrome: il browser predefinito, o in ultima battuta una WebView (sempre senza barra).
 */
public class AvvioActivity extends LauncherActivity {
    private static final String[] CHROME = {
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary"};

    @Override
    protected TwaLauncher createTwaLauncher() {
        for (String p : CHROME) if (attivo(p)) return new TwaLauncher(this, p);
        return super.createTwaLauncher();
    }

    private boolean attivo(String pacchetto) {
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(pacchetto, 0);
            return ai.enabled;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
