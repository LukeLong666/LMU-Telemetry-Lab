package com.lmutl.application;

import com.lmutl.api.error.ApiException;
import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.MetadataReader;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Path;
import java.sql.Connection;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

@Service
public class SetupService {

    private final SessionService sessionService;
    private final DuckDbConnectionFactory connections;
    private final MetadataReader metadataReader;
    private final ObjectMapper mapper;

    public SetupService(SessionService sessionService,
                        DuckDbConnectionFactory connections,
                        MetadataReader metadataReader,
                        ObjectMapper mapper) {
        this.sessionService = sessionService;
        this.connections = connections;
        this.metadataReader = metadataReader;
        this.mapper = mapper;
    }

    public Map<String, Object> getSetup(String profileId, String sessionId) {
        Path database = sessionService.resolve(profileId, sessionId);
        JsonNode setup = readSetup(database);
        if (setup == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "CarSetup not found in metadata");
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("powertrain", powertrain(setup));
        result.put("wheelsAndBrakes", wheelsAndBrakes(setup));
        result.put("suspension", suspension(setup));
        result.put("dampers", dampers(setup));
        result.put("chassisAndAero", chassisAndAero(setup));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("setup", result);
        return body;
    }

    public JsonNode readSetup(Path database) {
        try (Connection connection = connections.open(database)) {
            Map<String, String> metadata = metadataReader.read(connection);
            String raw = metadata.get("CarSetup");
            if (raw == null || raw.isBlank()) {
                return null;
            }
            return mapper.readTree(raw);
        } catch (Exception e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to read CarSetup", e);
        }
    }

    public Map<String, String> readMetadata(Path database) {
        try (Connection connection = connections.open(database)) {
            return metadataReader.read(connection);
        } catch (Exception e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to read session metadata", e);
        }
    }

    private Map<String, Object> powertrain(JsonNode setup) {
        Map<String, Object> engine = new LinkedHashMap<>();
        engine.put("Virtual Energy", val(setup, "VM_VIRTUAL_ENERGY"));
        engine.put("Fuel Ratio", val(setup, "VM_FUEL_LEVEL"));
        engine.put("Fuel Capacity", val(setup, "VM_FUEL_CAPACITY"));
        engine.put("Rev Limiter", val(setup, "VM_REV_LIMITER"));
        engine.put("Engine Mixture", val(setup, "VM_ENGINE_MIXTURE"));
        engine.put("Water Radiator", val(setup, "VM_WATER_RADIATOR"));
        engine.put("Oil Radiator", val(setup, "VM_OIL_RADIATOR"));

        Map<String, Object> electronics = new LinkedHashMap<>();
        electronics.put("Onboard TC", val(setup, "VM_TRACTIONCONTROLMAP"));
        electronics.put("TC Power Cut", val(setup, "VM_TRACTIONCONTROLPOWERCUTMAP"));
        electronics.put("TC Slip Angle", val(setup, "VM_TRACTIONCONTROLSLIPANGLEMAP"));
        electronics.put("Regen Level", val(setup, "VM_REGEN_LEVEL"));
        electronics.put("Electric Motor Map", val(setup, "VM_ELECTRIC_MOTOR_MAP"));

        Map<String, Object> differential = new LinkedHashMap<>();
        differential.put("Power", val(setup, "VM_DIFF_POWER"));
        differential.put("Coast", val(setup, "VM_DIFF_COAST"));
        differential.put("Preload", val(setup, "VM_DIFF_PRELOAD"));
        differential.put("Front Power", val(setup, "VM_FRONT_DIFF_POWER"));
        differential.put("Front Coast", val(setup, "VM_FRONT_DIFF_COAST"));
        differential.put("Front Preload", val(setup, "VM_FRONT_DIFF_PRELOAD"));
        differential.put("Torque Split", val(setup, "VM_TORQUE_SPLIT"));

        Map<String, Object> gearing = new LinkedHashMap<>();
        gearing.put("Ratio Set", val(setup, "VM_RATIO_SET"));
        gearing.put("Gear 1", val(setup, "VM_GEAR_1"));
        gearing.put("Gear 2", val(setup, "VM_GEAR_2"));
        gearing.put("Gear 3", val(setup, "VM_GEAR_3"));
        gearing.put("Gear 4", val(setup, "VM_GEAR_4"));
        gearing.put("Gear 5", val(setup, "VM_GEAR_5"));
        gearing.put("Gear 6", val(setup, "VM_GEAR_6"));
        gearing.put("Gear 7", val(setup, "VM_GEAR_7"));
        gearing.put("Final Drive", val(setup, "VM_GEAR_FINAL"));
        gearing.put("Reverse", val(setup, "VM_GEAR_REVERSE"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("engine", engine);
        result.put("electronics", electronics);
        result.put("differential", differential);
        result.put("gearing", gearing);
        return result;
    }

    private Map<String, Object> wheelsAndBrakes(JsonNode setup) {
        Map<String, Object> front = new LinkedHashMap<>();
        front.put("Compound", lr(setup, "WM_COMPOUND-W_FL", "WM_COMPOUND-W_FR"));
        front.put("Tyre Pressure", lr(setup, "WM_PRESSURE-W_FL", "WM_PRESSURE-W_FR"));
        front.put("Camber", lr(setup, "WM_CAMBER-W_FL", "WM_CAMBER-W_FR"));
        front.put("Brake Disc", lr(setup, "WM_BRAKEDISC-W_FL", "WM_BRAKEDISC-W_FR"));
        front.put("Brake Pad", lr(setup, "WM_BRAKEPAD-W_FL", "WM_BRAKEPAD-W_FR"));

        Map<String, Object> rear = new LinkedHashMap<>();
        rear.put("Compound", lr(setup, "WM_COMPOUND-W_RL", "WM_COMPOUND-W_RR"));
        rear.put("Tyre Pressure", lr(setup, "WM_PRESSURE-W_RL", "WM_PRESSURE-W_RR"));
        rear.put("Camber", lr(setup, "WM_CAMBER-W_RL", "WM_CAMBER-W_RR"));
        rear.put("Brake Disc", lr(setup, "WM_BRAKEDISC-W_RL", "WM_BRAKEDISC-W_RR"));
        rear.put("Brake Pad", lr(setup, "WM_BRAKEPAD-W_RL", "WM_BRAKEPAD-W_RR"));

        Map<String, Object> brakes = new LinkedHashMap<>();
        brakes.put("Brake Bias", val(setup, "VM_BRAKE_BALANCE"));
        brakes.put("Brake Migration", val(setup, "VM_BRAKE_MIGRATION"));
        brakes.put("Max Pedal Force", val(setup, "VM_BRAKE_PRESSURE"));
        brakes.put("Front Brake Duct", val(setup, "VM_BRAKE_DUCTS"));
        brakes.put("Rear Brake Duct", val(setup, "VM_BRAKE_DUCTS_REAR"));
        brakes.put("ABS", val(setup, "VM_ANTILOCKBRAKESYSTEMMAP"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("frontWheels", front);
        result.put("rearWheels", rear);
        result.put("brakes", brakes);
        return result;
    }

    private Map<String, Object> suspension(JsonNode setup) {
        Map<String, Object> front = new LinkedHashMap<>();
        front.put("Spring Rate", lr3(setup, "WM_SPRING-W_FL", "VM_FRONT_3RD_SPRING", "WM_SPRING-W_FR"));
        front.put("Tender Spring", lr3(setup, "WM_TENDERSPRING-W_FL", "VM_FRONT_3RD_TENDERSPRING", "WM_TENDERSPRING-W_FR"));
        front.put("Packers", lr3(setup, "WM_PACKERS-W_FL", "VM_FRONT_3RD_PACKERS", "WM_PACKERS-W_FR"));
        front.put("Ride Height", lr3(setup, "WM_RIDEHEIGHT-W_FL", null, "WM_RIDEHEIGHT-W_FR"));
        front.put("Spring Rubber", lr3(setup, "WM_SRUBBER-W_FL", null, "WM_SRUBBER-W_FR"));

        Map<String, Object> rear = new LinkedHashMap<>();
        rear.put("Spring Rate", lr3(setup, "WM_SPRING-W_RL", "VM_REAR_3RD_SPRING", "WM_SPRING-W_RR"));
        rear.put("Tender Spring", lr3(setup, "WM_TENDERSPRING-W_RL", "VM_REAR_3RD_TENDERSPRING", "WM_TENDERSPRING-W_RR"));
        rear.put("Packers", lr3(setup, "WM_PACKERS-W_RL", "VM_REAR_3RD_PACKERS", "WM_PACKERS-W_RR"));
        rear.put("Ride Height", lr3(setup, "WM_RIDEHEIGHT-W_RL", null, "WM_RIDEHEIGHT-W_RR"));
        rear.put("Spring Rubber", lr3(setup, "WM_SRUBBER-W_RL", null, "WM_SRUBBER-W_RR"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("front", front);
        result.put("rear", rear);
        return result;
    }

    private Map<String, Object> dampers(JsonNode setup) {
        Map<String, Object> front = new LinkedHashMap<>();
        front.put("Slow Bump", lr3(setup, "WM_SLOWBUMP-W_FL", "VM_FRONT_3RD_SLOWBUMP", "WM_SLOWBUMP-W_FR"));
        front.put("Slow Rebound", lr3(setup, "WM_SLOWREBOUND-W_FL", "VM_FRONT_3RD_SLOWREBOUND", "WM_SLOWREBOUND-W_FR"));
        front.put("Fast Bump", lr3(setup, "WM_FASTBUMP-W_FL", "VM_FRONT_3RD_FASTBUMP", "WM_FASTBUMP-W_FR"));
        front.put("Fast Rebound", lr3(setup, "WM_FASTREBOUND-W_FL", "VM_FRONT_3RD_FASTREBOUND", "WM_FASTREBOUND-W_FR"));

        Map<String, Object> rear = new LinkedHashMap<>();
        rear.put("Slow Bump", lr3(setup, "WM_SLOWBUMP-W_RL", "VM_REAR_3RD_SLOWBUMP", "WM_SLOWBUMP-W_RR"));
        rear.put("Slow Rebound", lr3(setup, "WM_SLOWREBOUND-W_RL", "VM_REAR_3RD_SLOWREBOUND", "WM_SLOWREBOUND-W_RR"));
        rear.put("Fast Bump", lr3(setup, "WM_FASTBUMP-W_RL", "VM_REAR_3RD_FASTBUMP", "WM_FASTBUMP-W_RR"));
        rear.put("Fast Rebound", lr3(setup, "WM_FASTREBOUND-W_RL", "VM_REAR_3RD_FASTREBOUND", "WM_FASTREBOUND-W_RR"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("front", front);
        result.put("rear", rear);
        return result;
    }

    private Map<String, Object> chassisAndAero(JsonNode setup) {
        Map<String, Object> front = new LinkedHashMap<>();
        front.put("Caster L", val(setup, "VM_LEFT_CASTER"));
        front.put("Caster R", val(setup, "VM_RIGHT_CASTER"));
        front.put("Toe-in", val(setup, "VM_FRONT_TOEIN"));
        front.put("Anti-roll Bar", val(setup, "VM_FRONT_ANTISWAY"));
        front.put("Wheel Track", val(setup, "VM_FRONT_WHEEL_TRACK"));
        front.put("Wheel Range", val(setup, "VM_STEER_LOCK"));
        front.put("Front Wing", val(setup, "VM_FRONT_WING"));

        Map<String, Object> rear = new LinkedHashMap<>();
        rear.put("Toe-in", val(setup, "VM_REAR_TOEIN"));
        rear.put("Anti-roll Bar", val(setup, "VM_REAR_ANTISWAY"));
        rear.put("Wheel Track", val(setup, "VM_REAR_WHEEL_TRACK"));
        rear.put("Rear Wing", val(setup, "VM_REAR_WING"));

        Map<String, Object> weight = new LinkedHashMap<>();
        weight.put("Vertical", val(setup, "VM_WEIGHT_VERTICAL"));
        weight.put("Lateral", val(setup, "VM_WEIGHT_LATERAL"));
        weight.put("Weight Distribution", val(setup, "VM_WEIGHT_DISTRIB"));
        weight.put("Wedge", val(setup, "VM_WEIGHT_WEDGE"));

        Map<String, Object> advanced = new LinkedHashMap<>();
        for (int i = 0; i < 6; i++) {
            advanced.put("Chassis Adj " + i, val(setup, String.format(Locale.ROOT, "VM_CHASSIS_ADJ_%02d", i)));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("frontChassis", front);
        result.put("rearChassis", rear);
        result.put("weight", weight);
        result.put("advancedChassis", advanced);
        return result;
    }

    private String val(JsonNode setup, String key) {
        JsonNode entry = setup.path(key);
        if (!entry.isObject() || !entry.path("available").asBoolean(false)) {
            return null;
        }
        String value = entry.path("stringValue").asText("");
        if (value.isBlank() || "N/A".equals(value)) {
            return null;
        }
        return value;
    }

    private Map<String, Object> lr(JsonNode setup, String left, String right) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("L", val(setup, left));
        result.put("R", val(setup, right));
        return result;
    }

    private Map<String, Object> lr3(JsonNode setup, String left, String third, String right) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("L", val(setup, left));
        result.put("3rd", third == null ? null : val(setup, third));
        result.put("R", val(setup, right));
        return result;
    }
}
