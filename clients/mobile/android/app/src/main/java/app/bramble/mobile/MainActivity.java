package app.bramble.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import androidx.activity.EdgeToEdge;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Android 13 can blank the Recents card alone; older versions need FLAG_SECURE for it.
    private static final boolean CARD_SWITCH = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutofillBridgePlugin.class);
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(FileSaverPlugin.class);
        registerPlugin(NativeCryptoPlugin.class);
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(ScreenCapturePlugin.class);
        super.onCreate(savedInstanceState);
        // Draw under the system bars below Android 15 too, as 15+ forces; mobile.css pads (#173).
        // After super: touching the window decor any earlier builds it with an action bar.
        EdgeToEdge.enable(this);
        // Keep the vault out of the Recents card (#148), even with screenshots allowed.
        if (CARD_SWITCH) setRecentsScreenshotEnabled(false);
        // A pause ends with the activity that started it, even when the process lives on.
        ScreenCapture.INSTANCE.endPause();
        ScreenCapture.INSTANCE.apply(this);
    }

    // Below 13, FLAG_SECURE while the app is away blanks the Recents card even with screenshots
    // allowed; resuming puts the "Block screenshots" setting back.
    @Override
    public void onPause() {
        if (!CARD_SWITCH) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        ScreenCapture.INSTANCE.apply(this);
    }
}
