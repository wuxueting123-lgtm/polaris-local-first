package com.alyssa.polaris;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SystemFilePlugin.class);
        registerPlugin(LocalDataSqlitePlugin.class);
        registerPlugin(NativeProviderHttpPlugin.class);
        super.onCreate(savedInstanceState);

        ViewCompat.setOnApplyWindowInsetsListener(
            getWindow().getDecorView().getRootView(),
            (v, insets) -> {
                int bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
                v.setPadding(0, 0, 0, bottom);
                return insets;
            }
        );
    }
}
