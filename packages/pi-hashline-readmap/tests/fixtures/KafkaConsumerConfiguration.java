package com.example.kafka;

import java.util.Map;
import org.springframework.context.annotation.Bean;

public class KafkaConsumerConfiguration {
  private final String bootstrapServers;

  public KafkaConsumerConfiguration(String bootstrapServers) {
    this.bootstrapServers = bootstrapServers;
  }

  @Bean
  public Map<String, Object> consumerFactory() {
    return Map.of("bootstrap.servers", bootstrapServers, "helper", helperName());
  }

  private String helperName() {
    return "consumer";
  }
}
