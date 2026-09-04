package com.example.taxiradar

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    private lateinit var licenseManager: LicenseManager

    private lateinit var tvLicenseStatus: TextView
    private lateinit var layoutActivation: LinearLayout
    private lateinit var etLicenseKey: EditText
    private lateinit var btnActivate: Button
    private lateinit var btnLaunchWidget: Button
    private lateinit var btnTelegram: Button
    private lateinit var btnCall: Button

    private val telegramUsername = "sigmalxl"
    private val contactPhoneNumber = "+37378293919"

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        if (Settings.canDrawOverlays(this)) {
            startOverlayService()
        } else {
            Toast.makeText(this, "Требуется разрешение поверх окон", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        licenseManager = LicenseManager(this)

        tvLicenseStatus = findViewById(R.id.tvLicenseStatus)
        layoutActivation = findViewById(R.id.layoutActivation)
        etLicenseKey = findViewById(R.id.etLicenseKey)
        btnActivate = findViewById(R.id.btnActivate)
        btnLaunchWidget = findViewById(R.id.btnLaunchWidget)
        btnTelegram = findViewById(R.id.btnTelegram)
        btnCall = findViewById(R.id.btnCall)

        // Фоновая проверка актуального статуса с сервера
        checkServerStatus()

        // Кнопка ввода ключа
        btnActivate.setOnClickListener {
            val key = etLicenseKey.text.toString().trim()
            if (key.isEmpty()) {
                Toast.makeText(this, "Введите ключ", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            btnActivate.isEnabled = false
            btnActivate.text = "Проверка..."

            CoroutineScope(Dispatchers.Main).launch {
                val result = licenseManager.activateKey(key)
                btnActivate.isEnabled = true
                btnActivate.text = "Активировать"

                Toast.makeText(this@MainActivity, result.second, Toast.LENGTH_SHORT).show()
                if (result.first) {
                    updateUiState(isBanned = false, isLicensed = true)
                }
            }
        }

        btnTelegram.setOnClickListener {
            try {
                val text = "Привет! Хочу купить доступ для Taxi Radar. Мой ID: ${licenseManager.deviceId}"
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/$telegramUsername?text=${URLEncoder.encode(text, "UTF-8")}"))
                startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(this, "Telegram не установлен", Toast.LENGTH_SHORT).show()
            }
        }

        btnCall.setOnClickListener {
            try {
                startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$contactPhoneNumber")))
            } catch (e: Exception) {
                Toast.makeText(this, "Не удалось открыть вызов", Toast.LENGTH_SHORT).show()
            }
        }

        btnLaunchWidget.setOnClickListener {
            if (!licenseManager.isLicensed()) {
                Toast.makeText(this, "Доступ закрыт", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (!Settings.canDrawOverlays(this)) {
                overlayPermissionLauncher.launch(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
                )
            } else {
                startOverlayService()
            }
        }
    }

    private fun checkServerStatus() {
        CoroutineScope(Dispatchers.Main).launch {
            val isOnlineValid = licenseManager.checkDeviceStatus()
            if (!isOnlineValid) {
                // Если не валидно — пробуем запросить триал (для новых) или ловим причину
                val trialResult = licenseManager.checkOrStartTrial()
                if (trialResult.first) {
                    updateUiState(isBanned = false, isLicensed = true)
                } else {
                    val isBan = trialResult.second.contains("БАН", ignoreCase = true)
                    updateUiState(isBanned = isBan, isLicensed = false, customMsg = trialResult.second)
                }
            } else {
                updateUiState(isBanned = false, isLicensed = true)
            }
        }
    }

    private fun updateUiState(isBanned: Boolean, isLicensed: Boolean, customMsg: String? = null) {
        if (isBanned) {
            tvLicenseStatus.text = "ДОСТУП ЗАБЛОКИРОВАН (БАН)"
            tvLicenseStatus.setTextColor(Color.parseColor("#E53935"))
            layoutActivation.visibility = View.VISIBLE
            btnLaunchWidget.visibility = View.GONE
        } else if (isLicensed) {
            val days = licenseManager.getRemainingDays()
            tvLicenseStatus.text = "Подписка активна (осталось дней: $days)"
            tvLicenseStatus.setTextColor(Color.parseColor("#00E676"))
            layoutActivation.visibility = View.GONE
            btnLaunchWidget.visibility = View.VISIBLE
        } else {
            tvLicenseStatus.text = customMsg ?: "Срок действия истек. Введите ключ"
            tvLicenseStatus.setTextColor(Color.parseColor("#FF9800"))
            layoutActivation.visibility = View.VISIBLE
            btnLaunchWidget.visibility = View.GONE
        }
    }

    private fun startOverlayService() {
        val serviceIntent = Intent(this, FloatingWidgetService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        Toast.makeText(this, "Виджет запущен", Toast.LENGTH_SHORT).show()
        moveTaskToBack(true)
    }
}
