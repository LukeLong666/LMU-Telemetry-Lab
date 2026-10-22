package com.lmutl.infra.system;

import com.lmutl.api.dto.SystemDtos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.swing.JFileChooser;
import javax.swing.SwingUtilities;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.GraphicsEnvironment;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Compatibility implementation for POST /system/pick-and-upload.
 * Electron uses its native dialog + /system/import-paths instead.
 */
@Component
public class FilePicker {

    private static final Logger log = LoggerFactory.getLogger(FilePicker.class);

    public List<Path> pick(SystemDtos.OpenPathRequest request) {
        if (GraphicsEnvironment.isHeadless()) {
            throw new IllegalStateException("Native file picker is unavailable in headless mode");
        }
        AtomicReference<List<Path>> result = new AtomicReference<>(List.of());
        try {
            SwingUtilities.invokeAndWait(() -> result.set(showDialog(request)));
        } catch (Exception e) {
            log.error("Native file picker failed", e);
            throw new IllegalStateException("Native file picker failed: " + e.getMessage(), e);
        }
        return result.get();
    }

    private List<Path> showDialog(SystemDtos.OpenPathRequest request) {
        JFileChooser chooser = new JFileChooser();
        chooser.setMultiSelectionEnabled(true);
        chooser.setDialogTitle("Select LMU Telemetry File(s) (.duckdb)");
        chooser.setFileFilter(new FileNameExtensionFilter("DuckDB files", "duckdb"));

        if (request != null && request.path() != null && !request.path().isBlank()) {
            Path initial = Path.of(request.path()).toAbsolutePath().normalize();
            if (Files.isDirectory(initial)) {
                chooser.setCurrentDirectory(initial.toFile());
            } else if (Files.isRegularFile(initial) && initial.getParent() != null) {
                chooser.setCurrentDirectory(initial.getParent().toFile());
            }
        }

        if (request != null && request.x() != null && request.y() != null) {
            int centerX = request.x() + (request.width() == null ? 0 : request.width() / 2);
            int centerY = request.y() + (request.height() == null ? 0 : request.height() / 2);
            chooser.setLocation(centerX, centerY);
        }

        int choice = chooser.showOpenDialog(null);
        if (choice != JFileChooser.APPROVE_OPTION) {
            return List.of();
        }
        List<Path> selected = new ArrayList<>();
        for (java.io.File file : chooser.getSelectedFiles()) {
            selected.add(file.toPath());
        }
        if (selected.isEmpty() && chooser.getSelectedFile() != null) {
            selected.add(chooser.getSelectedFile().toPath());
        }
        return selected;
    }
}
